import { env } from "../config/env.js";
import { OpenAIConversionDelivery } from "../models/openai-conversion-delivery.js";
import { Order } from "../models/order.js";
import { analyticsRetryDelayMs } from "./analytics-purchase.js";
import { buildOpenAIConversionPayload } from "./openai-conversion.js";

const MAX_ATTEMPTS = 10;
const LEASE_MS = 120_000;
const POLL_MS = 5_000;
let timer: NodeJS.Timeout | undefined;
let draining = false;

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : "OpenAI conversion delivery failed")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);
}

async function leaseNext(now: Date) {
  return OpenAIConversionDelivery.findOneAndUpdate(
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

export async function processNextOpenAIConversion(): Promise<boolean> {
  if (!env.OPENAI_CONVERSIONS_ENABLED) return false;
  const delivery = await leaseNext(new Date());
  if (!delivery) return false;
  try {
    const endpoint = new URL("https://bzr.openai.com/v1/events");
    endpoint.searchParams.set("pid", env.OPENAI_ADS_PIXEL_ID!);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENAI_CONVERSIONS_API_KEY!}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(
        buildOpenAIConversionPayload(delivery, env.OPENAI_CONVERSION_SOURCE_URL!),
      ),
    });
    if (!response.ok) throw new Error(`OpenAI conversion request rejected (${response.status})`);
    const sentAt = new Date();
    await OpenAIConversionDelivery.updateOne(
      { _id: delivery._id, status: "SENDING" },
      { $set: { status: "SENT", sentAt }, $unset: { leaseExpiresAt: 1, lastError: 1 } },
    );
    await recordAudit(delivery.orderId, "openai_conversion_sent", sentAt);
  } catch (error) {
    const permanent = delivery.attempts >= MAX_ATTEMPTS;
    const createdAt = new Date();
    await OpenAIConversionDelivery.updateOne(
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
    if (permanent) await recordAudit(delivery.orderId, "openai_conversion_failed", createdAt);
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
    while (await processNextOpenAIConversion()) {
      // Drain all jobs currently ready for delivery.
    }
  } catch (error) {
    console.error("OpenAI conversion outbox worker failed", safeError(error));
  } finally {
    draining = false;
  }
}

export function startOpenAIConversionOutboxWorker(): void {
  if (!env.OPENAI_CONVERSIONS_ENABLED || timer) return;
  void drain();
  timer = setInterval(() => void drain(), POLL_MS);
  timer.unref();
}
