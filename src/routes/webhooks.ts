import { Router } from "express";
import Stripe from "stripe";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { StripeEvent } from "../models/staff.js";
import { paymentNoticeForEvent } from "../lib/payment-events.js";
import { recordPayment } from "../lib/payment-state.js";
const stripe = new Stripe(env.STRIPE_SECRET_KEY);
export const webhookRouter = Router();
webhookRouter.post("/stripe", async (req, res, next) => {
  try {
    const signature = req.header("stripe-signature");
    if (!signature) return res.status(400).json({ message: "Missing Stripe signature" });
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(req.body, signature, env.STRIPE_WEBHOOK_SECRET);
    } catch {
      return res.status(400).json({ message: "Invalid Stripe signature" });
    }
    if (await StripeEvent.exists({ _id: event.id }))
      return res.json({ received: true, duplicate: true });
    const notice = await paymentNoticeForEvent(stripe, event);
    let duplicate = false;
    try {
      await mongoose.connection.transaction(async (session) => {
        duplicate = false;
        if (await StripeEvent.exists({ _id: event.id }).session(session)) {
          duplicate = true;
          return;
        }
        await StripeEvent.create(
          [{ _id: event.id, type: event.type, orderId: notice?.orderId, receivedAt: new Date() }],
          { session },
        );
        if (notice) await recordPayment(notice, session);
      });
    } catch (error) {
      // A concurrent delivery may win the unique event-id insert. Only that
      // precise committed duplicate is acknowledged; infrastructure errors
      // must fail so Stripe retries the entire transaction.
      if (
        (error as { code?: number }).code === 11000 &&
        (await StripeEvent.exists({ _id: event.id }))
      )
        duplicate = true;
      else throw error;
    }
    res.json({ received: true, duplicate });
  } catch (error) {
    next(error);
  }
});
