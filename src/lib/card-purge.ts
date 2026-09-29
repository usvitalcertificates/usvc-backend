import { Order } from "../models/order.js";
import { decryptSensitive } from "./crypto.js";

/** Last 4 digits of a card number (digits only). Safe to keep as a reference. */
export function computeCardLast4(pan: string): string {
  const digits = pan.replace(/\D/g, "");
  if (digits.length < 4) return "";
  return digits.slice(-4);
}

/** Start of the current day in server local time. Submissions before this are purged. */
export function startOfToday(now: Date = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** A submitted order is purge-eligible once its agency submission is before the cutoff. */
export function isPurgeEligible(
  status: string,
  submittedToAgencyAt: unknown,
  cutoff: Date = startOfToday(),
): boolean {
  if (status !== "SUBMITTED" || !submittedToAgencyAt) return false;
  const submitted = new Date(submittedToAgencyAt as string);
  return Number.isFinite(submitted.getTime()) && submitted.getTime() < cutoff.getTime();
}

export interface CardPurgeResult {
  purged: number;
  skipped: number;
}

/**
 * Clears full card ciphertext for submitted orders filed before today, keeping
 * only the last 4 digits for reference. SSN ciphertext is never touched.
 * Idempotent: re-runs skip orders whose card fields are already empty.
 */
export async function purgeSubmittedCards(options?: {
  limit?: number;
  now?: Date;
}): Promise<CardPurgeResult> {
  const now = options?.now ?? new Date();
  const limit = options?.limit ?? 100;
  const cutoff = startOfToday(now);
  const candidates = await Order.find(
    {
      status: "SUBMITTED",
      "confidentialData.cardNumberEnc": { $ne: "" },
      "customerTimeline.submittedToAgencyAt": { $lt: cutoff },
    },
    { confidentialData: 1 },
  )
    .limit(limit)
    .lean();
  let purged = 0;
  let skipped = 0;
  for (const doc of candidates) {
    const secrets = (doc.confidentialData ?? {}) as Record<string, string>;
    let last4 = secrets.cardLast4 ?? "";
    if (!last4 && secrets.cardNumberEnc) {
      try {
        last4 = computeCardLast4(decryptSensitive(secrets.cardNumberEnc));
      } catch {
        last4 = "";
      }
    }
    const updated = await Order.updateOne(
      { _id: doc._id, status: "SUBMITTED", "confidentialData.cardNumberEnc": { $ne: "" } },
      {
        $set: {
          "confidentialData.cardNumberEnc": "",
          "confidentialData.cardExpiryEnc": "",
          "confidentialData.cardCvcEnc": "",
          "confidentialData.cardLast4": last4,
        },
        $push: {
          auditEvents: {
            action: "card_purged",
            metadata: {},
            createdAt: new Date(),
          },
        },
      },
    );
    if (updated.modifiedCount > 0) purged += 1;
    else skipped += 1;
  }
  return { purged, skipped };
}

function msUntilHour(hour: number, now: Date = new Date()): number {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

let timer: NodeJS.Timeout | undefined;

/** Runs the purge once a day at the given server-local hour (default 4 AM). */
export function startCardPurgeWorker(hour = 4): void {
  if (timer) return;
  const schedule = (): void => {
    timer = setTimeout(() => {
      void purgeSubmittedCards()
        .catch((error: unknown) => {
          console.error(
            "Card purge worker failed",
            error instanceof Error ? error.message : "unknown error",
          );
        })
        .finally(schedule);
    }, msUntilHour(hour));
    timer.unref?.();
  };
  schedule();
}
