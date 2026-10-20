import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { Order, type OrderDoc } from "../models/order.js";
import { env } from "../config/env.js";
import { ApiError } from "../middleware/errors.js";
import { intentNotice, checkoutNotice, matchesPayment, recordPayment } from "./payment-state.js";

export const PAYMENT_PROCESSING_MESSAGE =
  "Your payment is still being checked. Please wait a minute and try again. We will check the existing payment before attempting another charge.";
const RECONCILE_AFTER_MS = 60_000;
// Stripe may prune idempotency keys after 24h. Never recreate an unknown
// Checkout Session (which could already have charged) outside this window.
const CREATE_REPLAY_WINDOW_MS = 23 * 60 * 60 * 1000;
export type AttemptOrder = OrderDoc & { _id: { toString(): string; toHexString(): string } };

export function newPaymentAttempt(kind: "DIRECT" | "CHECKOUT") {
  return {
    id: randomUUID(),
    kind,
    state: "RESERVED",
    recoveryEmailEligible: true,
    startedAt: new Date(),
  };
}

export function processingPayment(): never {
  // No orderId: the current browser treats 409 + orderId as already paid.
  throw new ApiError(423, PAYMENT_PROCESSING_MESSAGE);
}

export function reservationFilter(order: AttemptOrder) {
  return {
    _id: order._id,
    paymentStatus: { $in: ["PENDING", "FAILED"] },
    status: { $in: ["DRAFT", "AWAITING_PAYMENT"] },
    ...(order.paymentAttempt
      ? { "paymentAttempt.id": order.paymentAttempt.id, "paymentAttempt.state": "FAILED" }
      : {
          "paymentAttempt.id": { $exists: false },
          chargeAttempts: { $in: [null, 0] },
          stripePaymentIntentId: { $exists: false },
          stripeCheckoutSessionId: { $exists: false },
        }),
  };
}

/** Creating an empty intent cannot charge. Its reference must win the Mongo
 *  fence before any worker may supply a card and confirm it. */
export async function ensureDirectIntent(stripe: Stripe, order: AttemptOrder) {
  if (order.stripePaymentIntentId)
    return stripe.paymentIntents.retrieve(order.stripePaymentIntentId);
  const attempt = order.paymentAttempt;
  if (!attempt || attempt.kind !== "DIRECT") return processingPayment();
  if (Date.now() - attempt.startedAt.getTime() >= CREATE_REPLAY_WINDOW_MS)
    return processingPayment();
  const intent = await stripe.paymentIntents.create(
    {
      amount: order.amountCents,
      currency: order.currency,
      payment_method_types: ["card"],
      description: `USVC ${order.publicNumber} - Online Processing Fee`,
      receipt_email: order.applicant?.email || undefined,
      metadata: {
        orderId: String(order._id),
        orderNumber: order.publicNumber,
        paymentAttemptId: attempt.id,
      },
    },
    { idempotencyKey: `usvc_payment_${attempt.id}_create` },
  );
  if (!matchesPayment({ ...order, stripePaymentIntentId: intent.id }, intentNotice(intent)))
    return processingPayment();
  const saved = await Order.updateOne(
    {
      _id: order._id,
      "paymentAttempt.id": attempt.id,
      "paymentAttempt.state": "RESERVED",
      stripePaymentIntentId: { $exists: false },
      paymentStatus: { $nin: ["PAID", "REFUNDED"] },
    },
    { $set: { stripePaymentIntentId: intent.id, "paymentAttempt.state": "READY" } },
  );
  if (!saved.matchedCount) {
    const latest = await Order.findById(order._id).lean();
    if (latest?.paymentAttempt?.id !== attempt.id || latest.stripePaymentIntentId !== intent.id)
      return processingPayment();
  }
  return intent;
}

/** Use the stored pricing snapshot, including for old orders and retries. */
export function checkoutParams(order: AttemptOrder): Stripe.Checkout.SessionCreateParams {
  const certLabel = order.certificate.charAt(0) + order.certificate.slice(1).toLowerCase();
  const metadata = {
    orderId: String(order._id),
    orderNumber: order.publicNumber,
    paymentAttemptId: order.paymentAttempt!.id,
  };
  return {
    mode: "payment",
    ui_mode: "elements",
    customer_email: order.applicant?.email,
    return_url: `${env.FRONTEND_URL}/order/confirmation/${String(order._id)}?session_id={CHECKOUT_SESSION_ID}`,
    line_items: [
      {
        quantity: order.copies,
        price_data: {
          currency: order.currency,
          unit_amount: order.pricing!.serviceCents / order.copies,
          product_data: {
            name: `${order.stateName} ${certLabel} Certificate - Online Processing Fee`,
          },
        },
      },
      ...(order.pricing!.rushCents
        ? [
            {
              quantity: 1,
              price_data: {
                currency: order.currency,
                unit_amount: order.pricing!.rushCents,
                product_data: { name: "Rush Processing" },
              },
            },
          ]
        : []),
    ],
    metadata,
    payment_intent_data: {
      description: `USVC ${order.publicNumber} - Complete Order Payment`,
      metadata,
    },
  };
}

export async function ensureCheckoutSession(stripe: Stripe, order: AttemptOrder) {
  if (order.stripeCheckoutSessionId)
    return stripe.checkout.sessions.retrieve(order.stripeCheckoutSessionId);
  const attempt = order.paymentAttempt;
  if (
    !attempt ||
    attempt.kind !== "CHECKOUT" ||
    Date.now() - attempt.startedAt.getTime() >= CREATE_REPLAY_WINDOW_MS
  )
    return processingPayment();
  const session = await stripe.checkout.sessions.create(checkoutParams(order), {
    idempotencyKey: `usvc_payment_${attempt.id}_checkout`,
  });
  const saved = await Order.updateOne(
    {
      _id: order._id,
      "paymentAttempt.id": attempt.id,
      "paymentAttempt.state": "RESERVED",
      stripeCheckoutSessionId: { $exists: false },
      paymentStatus: { $nin: ["PAID", "REFUNDED"] },
    },
    { $set: { stripeCheckoutSessionId: session.id, "paymentAttempt.state": "READY" } },
  );
  if (!saved.matchedCount) {
    const latest = await Order.findById(order._id).lean();
    if (latest?.paymentAttempt?.id !== attempt.id || latest.stripeCheckoutSessionId !== session.id)
      return processingPayment();
  }
  return session;
}

async function releaseCancelledAttempt(order: AttemptOrder) {
  // Legacy direct charges could have additional, unrecorded intents. Refuse
  // another charge even if one recorded intent is cancelled.
  if (!order.paymentAttempt && order.chargeAttempts) return "PENDING" as const;
  const filter = order.paymentAttempt
    ? { "paymentAttempt.id": order.paymentAttempt.id }
    : { "paymentAttempt.id": { $exists: false } };
  const update = order.paymentAttempt
    ? { $set: { "paymentAttempt.state": "FAILED", paymentStatus: "FAILED" } }
    : {
        $set: { paymentStatus: "FAILED" },
        $unset: { stripePaymentIntentId: "", stripeCheckoutSessionId: "" },
      };
  const result = await Order.updateOne(
    {
      _id: order._id,
      ...filter,
      paymentStatus: { $nin: ["PAID", "REFUNDED"] },
      stripePaymentIntentId: order.stripePaymentIntentId ?? { $exists: false },
      stripeCheckoutSessionId: order.stripeCheckoutSessionId ?? { $exists: false },
    },
    update,
  );
  return result.matchedCount ? ("RETRY" as const) : ("PENDING" as const);
}

/** A timeout is not a decline. Only Stripe success or verified cancellation
 *  settles an attempt. Age merely permits checking/cancelling, never unlocks. */
export async function reconcilePayment(
  stripe: Stripe,
  order: AttemptOrder,
  cancelImmediately = false,
): Promise<"PAID" | "RETRY" | "PENDING"> {
  if (order.paymentStatus === "PAID") return "PAID";
  if (order.paymentStatus === "REFUNDED") return "PENDING";
  if (order.paymentAttempt?.state === "FAILED") return "RETRY";
  const canCancel =
    cancelImmediately ||
    !order.paymentAttempt ||
    Date.now() - order.paymentAttempt.startedAt.getTime() >= RECONCILE_AFTER_MS;
  if (order.stripeCheckoutSessionId || order.paymentAttempt?.kind === "CHECKOUT") {
    const session = await ensureCheckoutSession(stripe, order);
    const notice = checkoutNotice(session);
    const snapshot = { ...order, stripeCheckoutSessionId: session.id };
    if (!matchesPayment(snapshot, notice)) return "PENDING";
    if (session.payment_status === "paid")
      return (await recordPayment(notice)) ? "PAID" : "PENDING";
    // Open sessions remain reserved for Checkout. A direct retry must never
    // race a customer completing payment in an already-open Checkout tab.
    if (session.status !== "expired" || session.payment_status !== "unpaid") return "PENDING";
    if (notice.intentId) {
      const intent = await stripe.paymentIntents.retrieve(notice.intentId);
      if (intent.status !== "canceled") return "PENDING";
    }
    return releaseCancelledAttempt(snapshot);
  }
  if (order.stripePaymentIntentId || order.paymentAttempt?.kind === "DIRECT") {
    if (!order.stripePaymentIntentId && !canCancel) return "PENDING";
    let intent = await ensureDirectIntent(stripe, order);
    const snapshot = { ...order, stripePaymentIntentId: intent.id };
    if (!matchesPayment(snapshot, intentNotice(intent))) return "PENDING";
    if (intent.status === "succeeded")
      return (await recordPayment(intentNotice(intent))) ? "PAID" : "PENDING";
    if (
      intent.last_payment_error &&
      ["requires_payment_method", "canceled"].includes(intent.status)
    )
      await recordPayment({ ...intentNotice(intent), confirmedFailure: true });
    if (
      intent.status !== "canceled" &&
      canCancel &&
      ["requires_payment_method", "requires_confirmation", "requires_action"].includes(
        intent.status,
      )
    ) {
      try {
        intent = await stripe.paymentIntents.cancel(
          intent.id,
          {},
          {
            idempotencyKey: `usvc_payment_${order.paymentAttempt?.id ?? intent.id}_cancel`,
          },
        );
      } catch {
        // Confirmation may have won the race with cancellation. Re-read.
        intent = await stripe.paymentIntents.retrieve(intent.id);
      }
    }
    if (intent.status === "succeeded")
      return (await recordPayment(intentNotice(intent))) ? "PAID" : "PENDING";
    if (intent.status === "canceled") return releaseCancelledAttempt(snapshot);
    return "PENDING";
  }
  // Old unknown charges cannot be safely retried just because Mongo says FAILED.
  return order.chargeAttempts || order.paymentAttempt ? "PENDING" : "RETRY";
}
