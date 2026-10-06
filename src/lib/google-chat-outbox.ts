import { env } from "../config/env.js";
import { GoogleChatDelivery } from "../models/google-chat-delivery.js";
import { Order } from "../models/order.js";
import { analyticsRetryDelayMs } from "./analytics-purchase.js";
import { buildPaidOrderChatMessage } from "./google-chat.js";

const MAX_ATTEMPTS = 10;
const LEASE_MS = 120_000;
const POLL_MS = 5_000;
let timer: NodeJS.Timeout | undefined;
let draining = false;

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : "Google Chat delivery failed")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);
}

async function leaseNext(now: Date) {
  return GoogleChatDelivery.findOneAndUpdate(
    {
      $or: [
        { status: "PENDING", nextAttemptAt: { $lte: now } },
        { status: "SENDING", leaseExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: { status: "SENDING", leaseExpiresAt: new Date(now.getTime() + LEASE_MS) },
      $inc: { attempts: 1 },
    },
    { returnDocument: "after", sort: { nextAttemptAt: 1 } },
  );
}

/** Idempotent enqueue: one row per order, created on first paid confirmation
 *  from either the direct-charge path or the Stripe webhook. */
export async function queuePaidOrderChatNotice(order: {
  _id: unknown;
  publicNumber: string;
  applicant?: { firstName?: string; lastName?: string };
  stateName?: string;
  certificate?: string;
  deviceLocation?: { city?: string; region?: string };
  addresses?: { shipping?: { city?: string; state?: string } };
}): Promise<void> {
  const firstName = order.applicant?.firstName?.trim() ?? "";
  const lastName = order.applicant?.lastName?.trim() ?? "";
  await GoogleChatDelivery.updateOne(
    { _id: `chat-notify:${String(order._id)}` },
    {
      $setOnInsert: {
        orderId: order._id,
        publicNumber: order.publicNumber,
        customerName: `${firstName} ${lastName}`.trim(),
        stateName: order.stateName ?? "",
        certificate: order.certificate ?? "",
        deviceCity: order.deviceLocation?.city ?? "",
        deviceRegion: order.deviceLocation?.region ?? "",
        shipCity: order.addresses?.shipping?.city ?? "",
        shipState: order.addresses?.shipping?.state ?? "",
        status: "PENDING",
        attempts: 0,
        nextAttemptAt: new Date(),
      },
    },
    { upsert: true },
  );
}

export async function processNextGoogleChatDelivery(): Promise<boolean> {
  if (!env.GOOGLE_CHAT_WEBHOOK_URL) return false;
  const delivery = await leaseNext(new Date());
  if (!delivery) return false;
  try {
    const response = await fetch(env.GOOGLE_CHAT_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json; charset=UTF-8" },
      body: JSON.stringify(
        buildPaidOrderChatMessage({
          publicNumber: delivery.publicNumber,
          customerName: delivery.customerName,
          stateName: delivery.stateName ?? "",
          certificate: delivery.certificate ?? "",
          deviceCity: delivery.deviceCity ?? "",
          deviceRegion: delivery.deviceRegion ?? "",
          shipCity: delivery.shipCity ?? "",
          shipState: delivery.shipState ?? "",
        }),
      ),
    });
    if (!response.ok) throw new Error(`Google Chat request rejected (${response.status})`);
    const sentAt = new Date();
    await GoogleChatDelivery.updateOne(
      { _id: delivery._id, status: "SENDING" },
      { $set: { status: "SENT", sentAt }, $unset: { leaseExpiresAt: 1, lastError: 1 } },
    );
    await recordAudit(delivery.orderId, "chat_notice_sent", sentAt);
  } catch (error) {
    const permanent = delivery.attempts >= MAX_ATTEMPTS;
    const createdAt = new Date();
    await GoogleChatDelivery.updateOne(
      { _id: delivery._id, status: "SENDING" },
      {
        $set: {
          status: permanent ? "FAILED" : "PENDING",
          nextAttemptAt: new Date(createdAt.getTime() + analyticsRetryDelayMs(delivery.attempts)),
          lastError: safeError(error),
        },
        $unset: { leaseExpiresAt: 1 },
      },
    );
    if (permanent) await recordAudit(delivery.orderId, "chat_notice_failed", createdAt);
  }
  return true;
}

async function recordAudit(orderId: unknown, action: string, createdAt: Date): Promise<void> {
  await Order.updateOne(
    { _id: orderId },
    { $push: { auditEvents: { action, metadata: {}, createdAt } } },
  );
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (await processNextGoogleChatDelivery()) {
      // Drain all jobs currently ready for delivery.
    }
  } catch (error) {
    console.error("Google Chat outbox worker failed", safeError(error));
  } finally {
    draining = false;
  }
}

export function startGoogleChatOutboxWorker(): void {
  if (!env.GOOGLE_CHAT_WEBHOOK_URL || timer) return;
  void drain();
  timer = setInterval(() => void drain(), POLL_MS);
  timer.unref();
}
