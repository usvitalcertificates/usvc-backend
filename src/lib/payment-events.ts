import type Stripe from "stripe";
import mongoose from "mongoose";
import { Order } from "../models/order.js";
import { checkoutNotice, intentNotice, type PaymentNotice } from "./payment-state.js";

const INTENT_EVENTS = new Set(["payment_intent.succeeded", "payment_intent.payment_failed"]);
const CHECKOUT_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
]);

/** Read Stripe's current state, not the potentially old event snapshot.
 *  Reads happen before the Mongo transaction so transaction retries never
 *  repeat external effects. Unknown or mismatched events are acknowledged. */
export async function paymentNoticeForEvent(
  stripe: Stripe,
  event: Stripe.Event,
): Promise<PaymentNotice | null> {
  if (!INTENT_EVENTS.has(event.type) && !CHECKOUT_EVENTS.has(event.type)) return null;
  const object = event.data.object as Stripe.PaymentIntent | Stripe.Checkout.Session;
  const orderId = object.metadata?.orderId;
  if (!orderId || !mongoose.isValidObjectId(orderId)) return null;
  const order = await Order.findById(orderId, { stripeCheckoutSessionId: 1 }).lean();
  if (!order) return null;
  const occurredAt = event.type.endsWith("payment_failed")
    ? new Date()
    : new Date(event.created * 1000);
  if (INTENT_EVENTS.has(event.type)) {
    const intent = await stripe.paymentIntents.retrieve(object.id);
    if (intent.metadata.orderId !== orderId) return null;
    if (order.stripeCheckoutSessionId) {
      const checkout = await stripe.checkout.sessions.retrieve(order.stripeCheckoutSessionId);
      const checkoutIntentId =
        typeof checkout.payment_intent === "string"
          ? checkout.payment_intent
          : checkout.payment_intent?.id;
      if (checkoutIntentId !== intent.id || checkout.metadata?.orderId !== orderId) return null;
      // Checkout's paid state must agree with the current intent. Let the
      // subsequent Checkout event retry settlement if it is not yet visible.
      if (intent.status === "succeeded" && checkout.payment_status === "paid")
        return checkoutNotice(checkout, occurredAt);
      if (
        intent.status === "requires_payment_method" &&
        event.type === "payment_intent.payment_failed"
      )
        return checkoutNotice(checkout, occurredAt);
      return null;
    }
    if (intent.status === "succeeded") return intentNotice(intent, occurredAt);
    if (
      intent.status === "requires_payment_method" &&
      event.type === "payment_intent.payment_failed"
    )
      return intentNotice(intent, occurredAt);
    return null;
  }
  const checkout = await stripe.checkout.sessions.retrieve(object.id);
  if (checkout.metadata?.orderId !== orderId) return null;
  if (checkout.payment_status === "paid") return checkoutNotice(checkout, occurredAt);
  if (event.type === "checkout.session.async_payment_failed")
    return checkoutNotice(checkout, occurredAt);
  return null;
}
