import { env } from "../config/env.js";
import { AnalyticsPurchaseDelivery } from "../models/analytics-purchase-delivery.js";
import { Order } from "../models/order.js";
import { analyticsRetryDelayMs, buildPurchasePayload } from "./analytics-purchase.js";

export { analyticsRetryDelayMs, buildPurchasePayload } from "./analytics-purchase.js";

const MAX_ATTEMPTS = 10;
const LEASE_MS = 120_000;
const POLL_MS = 5_000;
let timer: NodeJS.Timeout | undefined;
let draining = false;

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : "GA4 delivery failed")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);
}

async function leaseNext(now: Date) {
  return AnalyticsPurchaseDelivery.findOneAndUpdate(
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

export async function processNextAnalyticsPurchase(): Promise<boolean> {
  if (!env.ANALYTICS_ENABLED) return false;
  const delivery = await leaseNext(new Date());
  if (!delivery) return false;
  try {
    const endpoint = new URL("https://www.google-analytics.com/mp/collect");
    endpoint.searchParams.set("measurement_id", env.GA_MEASUREMENT_ID!);
    endpoint.searchParams.set("api_secret", env.GA4_MEASUREMENT_PROTOCOL_API_SECRET!);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildPurchasePayload(delivery)),
    });
    if (!response.ok) throw new Error("GA4 request rejected");
    const sentAt = new Date();
    await AnalyticsPurchaseDelivery.updateOne(
      { _id: delivery._id, status: "SENDING" },
      { $set: { status: "SENT", sentAt }, $unset: { leaseExpiresAt: 1, lastError: 1 } },
    );
    await recordAnalyticsAudit(delivery.orderId, "analytics_purchase_sent", sentAt);
  } catch (error) {
    const permanent = delivery.attempts >= MAX_ATTEMPTS;
    const createdAt = new Date();
    await AnalyticsPurchaseDelivery.updateOne(
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
    if (permanent)
      await recordAnalyticsAudit(delivery.orderId, "analytics_purchase_failed", createdAt);
  }
  return true;
}

async function recordAnalyticsAudit(
  orderId: unknown,
  action: string,
  createdAt: Date,
): Promise<void> {
  await Order.updateOne(
    { _id: orderId },
    { $push: { auditEvents: { action, metadata: {}, createdAt } } },
  );
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (await processNextAnalyticsPurchase()) {
      // Drain all jobs currently ready for delivery.
    }
  } catch (error) {
    console.error("GA4 purchase outbox worker failed", safeError(error));
  } finally {
    draining = false;
  }
}

export function startAnalyticsOutboxWorker(): void {
  if (!env.ANALYTICS_ENABLED || timer) return;
  void drain();
  timer = setInterval(() => void drain(), POLL_MS);
  timer.unref();
}
