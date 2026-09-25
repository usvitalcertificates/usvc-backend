import { Router } from "express";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { EmailOutbox } from "../models/email-outbox.js";
import { AnalyticsPurchaseDelivery } from "../models/analytics-purchase-delivery.js";
import { OpenAIConversionDelivery } from "../models/openai-conversion-delivery.js";
import { Order } from "../models/order.js";
import { StripeEvent } from "../models/staff.js";
const stripe = new Stripe(env.STRIPE_SECRET_KEY);
export const webhookRouter = Router();
webhookRouter.post("/stripe", async (req, res, next) => {
  try {
    const signature = req.header("stripe-signature");
    if (!signature) throw new Error("Missing Stripe signature");
    const event = stripe.webhooks.constructEvent(req.body, signature, env.STRIPE_WEBHOOK_SECRET);
    const object = event.data.object as Stripe.PaymentIntent | Stripe.Checkout.Session;
    const orderId = (object.metadata?.["orderId"] ??
      (object as Stripe.PaymentIntent).metadata?.orderId) as string | undefined;
    const validId = orderId && mongoose.isValidObjectId(orderId) ? orderId : undefined;
    let duplicate = false;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        try {
          await StripeEvent.create(
            [{ _id: event.id, type: event.type, orderId: validId, receivedAt: new Date() }],
            { session },
          );
        } catch {
          duplicate = true;
          return;
        }
        let paymentConfirmed = false;
        const paymentConfirmedAt = new Date();
        if (validId && event.type === "payment_intent.succeeded") {
          await Order.updateOne(
            { _id: validId },
            {
              $set: {
                paymentStatus: "PAID",
                status: "PAID",
                stripePaymentIntentId: object.id,
                "customerTimeline.paymentSuccessfulAt": paymentConfirmedAt,
                "customerTimeline.orderReceivedAt": paymentConfirmedAt,
                updatedAt: paymentConfirmedAt,
              },
            },
            { session },
          );
          paymentConfirmed = true;
        }
        if (validId && event.type === "payment_intent.payment_failed")
          await Order.updateOne(
            { _id: validId },
            { $set: { paymentStatus: "FAILED", updatedAt: new Date() } },
            { session },
          );
        if (validId && event.type === "checkout.session.completed") {
          const sessionObject = object as Stripe.Checkout.Session;
          if (sessionObject.payment_status === "paid") {
            await Order.updateOne(
              { _id: validId },
              {
                $set: {
                  paymentStatus: "PAID",
                  status: "PAID",
                  stripeCheckoutSessionId: sessionObject.id,
                  "customerTimeline.paymentSuccessfulAt": paymentConfirmedAt,
                  "customerTimeline.orderReceivedAt": paymentConfirmedAt,
                  updatedAt: paymentConfirmedAt,
                },
              },
              { session },
            );
            paymentConfirmed = true;
          }
        }
        if (validId && event.type === "checkout.session.async_payment_succeeded") {
          const sessionObject = object as Stripe.Checkout.Session;
          await Order.updateOne(
            { _id: validId },
            {
              $set: {
                paymentStatus: "PAID",
                status: "PAID",
                stripeCheckoutSessionId: sessionObject.id,
                "customerTimeline.paymentSuccessfulAt": paymentConfirmedAt,
                "customerTimeline.orderReceivedAt": paymentConfirmedAt,
                updatedAt: paymentConfirmedAt,
              },
            },
            { session },
          );
          paymentConfirmed = true;
        }
        if (validId && event.type === "checkout.session.async_payment_failed")
          await Order.updateOne(
            { _id: validId },
            { $set: { paymentStatus: "FAILED", updatedAt: new Date() } },
            { session },
          );
        if (validId && paymentConfirmed) {
          const order = await Order.findById(
            validId,
            {
              "applicant.email": 1,
              publicNumber: 1,
              amountCents: 1,
              "pricing.serviceCents": 1,
              "pricing.rushCents": 1,
              currency: 1,
              certificate: 1,
              stateCode: 1,
              copies: 1,
              rush: 1,
              "analytics.clientId": 1,
              "analytics.sessionId": 1,
              "analytics.openAiEventId": 1,
              "analytics.openAiOppref": 1,
              "analytics.openAiObref": 1,
            },
            { session },
          ).lean();
          if (order?.applicant?.email) {
            const outboxId = `payment-confirmation:${validId}`;
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
                { _id: validId },
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
            const outboxId = `ga4-purchase:${validId}`;
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
                { _id: validId },
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
          if (order && paymentConfirmed && env.OPENAI_CONVERSIONS_ENABLED) {
            const openAiOutboxId = `openai-conversion:${validId}`;
            const openAiQueued = await OpenAIConversionDelivery.updateOne(
              { _id: openAiOutboxId },
              {
                $setOnInsert: {
                  orderId: order._id,
                  eventId: order.analytics?.openAiEventId || randomUUID(),
                  occurredAt: paymentConfirmedAt,
                  amountCents: order.amountCents,
                  currency: order.currency,
                  certificate: order.certificate,
                  copies: order.copies,
                  oppref: order.analytics?.openAiOppref ?? "",
                  obref: order.analytics?.openAiObref ?? "",
                  status: "PENDING",
                  attempts: 0,
                  nextAttemptAt: new Date(),
                },
              },
              { upsert: true, session },
            );
            if (openAiQueued.upsertedCount)
              await Order.updateOne(
                { _id: validId },
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
      });
    } finally {
      await session.endSession();
    }
    res.json({ received: true, duplicate });
  } catch (error) {
    next(error);
  }
});
