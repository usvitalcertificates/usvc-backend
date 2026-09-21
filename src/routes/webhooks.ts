import { Router } from "express";
import Stripe from "stripe";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { EmailOutbox } from "../models/email-outbox.js";
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
        if (validId && event.type === "payment_intent.succeeded") {
          await Order.updateOne(
            { _id: validId },
            {
              $set: {
                paymentStatus: "PAID",
                status: "PAID",
                stripePaymentIntentId: object.id,
                updatedAt: new Date(),
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
                  updatedAt: new Date(),
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
                updatedAt: new Date(),
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
          const order = await Order.findById(validId, { "applicant.email": 1 }, { session }).lean();
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
