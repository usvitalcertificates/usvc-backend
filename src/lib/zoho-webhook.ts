import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { env } from "../config/env.js";
import { EmailDispatch } from "../models/email-dispatch.js";
import { finishAcceptedEmail } from "./email-outbox.js";

/** Zoho signs the decoded value of its one form parameter, not the encoded body. */
export function verifyZohoWebhook(
  raw: Buffer,
  contentType: string,
  header: string,
  secret: string,
  now = Date.now(),
): unknown {
  if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded"))
    throw Error("Invalid webhook");
  const parts = header.split(";").map((part) => {
    const at = part.indexOf("=");
    return [part.slice(0, at).trim(), part.slice(at + 1)] as const;
  });
  const values = Object.fromEntries(parts);
  if (
    parts.length !== 3 ||
    new Set(parts.map(([key]) => key)).size !== 3 ||
    values["s-algorithm"] !== "HmacSHA256" ||
    !/^\d{13}$/.test(values.ts ?? "") ||
    Math.abs(now - Number(values.ts)) > 5 * 60_000
  )
    throw Error("Invalid webhook");
  const form = [...new URLSearchParams(raw.toString("utf8")).entries()];
  if (form.length !== 1) throw Error("Invalid webhook");
  const payload = form[0][1];
  const signature = decodeURIComponent(values.s);
  if (!/^[A-Za-z0-9+/]{43}=$/.test(signature)) throw Error("Invalid webhook");
  const actual = Buffer.from(signature, "base64");
  const expected = createHmac("sha256", secret).update(payload).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw Error("Invalid webhook");
  return JSON.parse(payload);
}
const info = z.object({
  client_reference: z.string().regex(/^[a-f0-9]{64}$/),
  email_reference: z.string().min(1).max(512),
  is_smtp_trigger: z.boolean(),
});
const eventSchema = z.object({
  mailagent_key: z.string().min(1),
  webhook_request_id: z.string().min(1).max(512),
  event_name: z.array(z.string()).length(1),
  event_message: z
    .array(z.object({ email_info: info }))
    .min(1)
    .max(100),
});
const outcomes = {
  softbounce: { status: "SOFT_BOUNCED", rank: 1 },
  delivered: { status: "DELIVERED", rank: 2 },
  hardbounce: { status: "HARD_BOUNCED", rank: 3 },
  feedback_loop: { status: "COMPLAINED", rank: 4 },
  fbl_complaint: { status: "COMPLAINED", rank: 4 },
} as const;

/** Monotonic receipt updates make duplicate/out-of-order events harmless. No payload is stored. */
export async function applyZohoWebhook(payload: unknown): Promise<void> {
  const event = eventSchema.parse(payload);
  // The Agent-specific HMAC key authenticates callbacks without OAuth/Agent-key setup.
  // If an Agent key is configured, retain that additional ownership restriction.
  if (env.ZOHO_EMAIL_AGENT_KEY && event.mailagent_key !== env.ZOHO_EMAIL_AGENT_KEY) return;
  const outcome = event.event_name
    .map((name) =>
      Object.hasOwn(outcomes, name) ? outcomes[name as keyof typeof outcomes] : undefined,
    )
    .filter((value) => value !== undefined)
    .sort((a, b) => b.rank - a.rank)[0];
  if (!outcome) return;
  for (const message of event.event_message) {
    const filter = {
      provider: "ZOHO",
      reference: message.email_info.client_reference,
      state: { $in: ["DISPATCHING", "UNCERTAIN", "REVIEW", "ACCEPTED"] },
    };
    const now = new Date();
    // Both delivery and bounce establish prior acceptance by Zoho, never a reason to resend.
    await EmailDispatch.updateOne(
      { ...filter, state: { $in: ["DISPATCHING", "UNCERTAIN", "REVIEW"] } },
      {
        $set: {
          state: "ACCEPTED",
          providerMessageId: message.email_info.email_reference,
          acceptedAt: now,
          nextReconcileAt: now,
        },
        $unset: { reconcileLeaseUntil: 1 },
      },
    );
    await EmailDispatch.updateOne(
      {
        ...filter,
        $or: [{ deliveryRank: { $exists: false } }, { deliveryRank: { $lt: outcome.rank } }],
      },
      {
        $set: {
          deliveryStatus: outcome.status,
          deliveryRank: outcome.rank,
          deliveryUpdatedAt: now,
        },
      },
    );
    await finishAcceptedEmail(await EmailDispatch.findOne(filter).lean());
  }
}
