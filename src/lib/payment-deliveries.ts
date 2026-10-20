import { randomUUID } from "node:crypto";
import type { ClientSession } from "mongoose";
import { env } from "../config/env.js";
import { EmailOutbox } from "../models/email-outbox.js";
import { AnalyticsPurchaseDelivery } from "../models/analytics-purchase-delivery.js";
import { OpenAIConversionDelivery } from "../models/openai-conversion-delivery.js";
import { hashOpenAIEmail } from "./openai-conversion.js";
import { Order } from "../models/order.js";
import { queuePaidOrderChatNotice } from "./google-chat-outbox.js";

/** All paid paths enqueue in the same Mongo transaction as the paid update.
 *  Per-order keys keep retries and distinct Stripe success events idempotent. */
export async function queuePaymentDeliveries(
  orderId: string,
  paidAt: Date,
  session: ClientSession,
) {
  const order = await Order.findById(
    orderId,
    {
      "applicant.email": 1,
      "applicant.firstName": 1,
      "applicant.lastName": 1,
      publicNumber: 1,
      stateName: 1,
      "deviceLocation.city": 1,
      "deviceLocation.region": 1,
      "addresses.shipping.city": 1,
      "addresses.shipping.state": 1,
      rush: 1,
      amountCents: 1,
      "pricing.serviceCents": 1,
      "pricing.rushCents": 1,
      currency: 1,
      certificate: 1,
      stateCode: 1,
      copies: 1,
      "analytics.clientId": 1,
      "analytics.sessionId": 1,
      "analytics.openAiEventId": 1,
      "analytics.openAiOppref": 1,
      "analytics.openAiObref": 1,
    },
    { session },
  ).lean();
  // Idempotent staff alert, committed with the other paid-order deliveries.
  if (order) await queuePaidOrderChatNotice(order, session);
  if (order?.applicant?.email) {
    const outboxId = `payment-confirmation:${orderId}`;
    const queued = await EmailOutbox.updateOne(
      { _id: outboxId },
      {
        $setOnInsert: {
          orderId: order._id,
          recipient: order.applicant.email,
          template: "PAYMENT_CONFIRMATION",
          status: "PENDING",
          attempts: 0,
          nextAttemptAt: new Date(),
        },
      },
      { upsert: true, session },
    );
    if (queued.upsertedCount)
      await Order.updateOne(
        { _id: orderId },
        {
          $push: {
            auditEvents: {
              action: "confirmation_email_queued",
              metadata: { outboxId },
              createdAt: new Date(),
            },
          },
        },
        { session },
      );
  }
  if (order && env.ANALYTICS_ENABLED) {
    const outboxId = `ga4-purchase:${orderId}`;
    const queued = await AnalyticsPurchaseDelivery.updateOne(
      { _id: outboxId },
      {
        $setOnInsert: {
          orderId: order._id,
          transactionId: order.publicNumber,
          amountCents: order.amountCents,
          serviceCents: order.pricing.serviceCents,
          rushCents: order.pricing.rushCents,
          currency: order.currency,
          certificate: order.certificate,
          stateCode: order.stateCode,
          copies: order.copies,
          rush: order.rush,
          clientId: order.analytics?.clientId ?? "",
          sessionId: order.analytics?.sessionId ?? "",
          status: "PENDING",
          attempts: 0,
          nextAttemptAt: new Date(),
        },
      },
      { upsert: true, session },
    );
    if (queued.upsertedCount)
      await Order.updateOne(
        { _id: orderId },
        {
          $push: {
            auditEvents: {
              action: "analytics_purchase_queued",
              metadata: { outboxId },
              createdAt: new Date(),
            },
          },
        },
        { session },
      );
  }
  // Server-side OpenAI Ads conversion (order_created) on verified
  // payment only. Mirrors the GA4 purchase outbox above: idempotent
  // per order, retried by the outbox worker, key never leaves the
  // server. The browser pixel fires the same event independently;
  // the shared eventId lets OpenAI deduplicate.
  if (order && env.OPENAI_CONVERSIONS_ENABLED) {
    const openAiOutboxId = `openai-conversion:${orderId}`;
    const openAiQueued = await OpenAIConversionDelivery.updateOne(
      { _id: openAiOutboxId },
      {
        $setOnInsert: {
          orderId: order._id,
          eventId: order.analytics?.openAiEventId || randomUUID(),
          occurredAt: paidAt,
          amountCents: order.amountCents,
          currency: order.currency,
          certificate: order.certificate,
          copies: order.copies,
          oppref: order.analytics?.openAiOppref ?? "",
          obref: order.analytics?.openAiObref ?? "",
          ...(order.applicant?.email?.trim()
            ? { emailHash: hashOpenAIEmail(order.applicant.email) }
            : {}),
          status: "PENDING",
          attempts: 0,
          nextAttemptAt: new Date(),
        },
      },
      { upsert: true, session },
    );
    if (openAiQueued.upsertedCount)
      await Order.updateOne(
        { _id: orderId },
        {
          $push: {
            auditEvents: {
              action: "openai_conversion_queued",
              metadata: { outboxId: openAiOutboxId },
              createdAt: new Date(),
            },
          },
        },
        { session },
      );
  }
}
