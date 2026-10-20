import mongoose, { type ClientSession } from "mongoose";
import type Stripe from "stripe";
import { env } from "../config/env.js";
import { Order } from "../models/order.js";
import { queuePaymentDeliveries } from "./payment-deliveries.js";

export interface PaymentOrder {
  _id: unknown;
  amountCents: number;
  currency: string;
  paymentStatus: string;
  stripePaymentIntentId?: string | null;
  stripeCheckoutSessionId?: string | null;
  paymentAttempt?: { id: string; kind: string; state: string; startedAt: Date } | null;
}

export interface PaymentNotice {
  orderId: string;
  intentId?: string;
  sessionId?: string;
  attemptId?: string;
  amountCents: number;
  currency: string;
  livemode: boolean;
  outcome: "PAID" | "FAILED";
  occurredAt: Date;
}

/** Metadata alone never establishes ownership: require the persisted Stripe
 *  reference too. Checkout-owned intents must also match their saved session. */
export function matchesPayment(order: PaymentOrder, notice: PaymentNotice): boolean {
  if (
    String(order._id) !== notice.orderId ||
    order.amountCents !== notice.amountCents ||
    order.currency.toLowerCase() !== notice.currency.toLowerCase() ||
    notice.livemode !== (env.PAYMENT_ENVIRONMENT === "live")
  )
    return false;
  if (order.paymentAttempt && order.paymentAttempt.id !== notice.attemptId) return false;
  if (order.paymentAttempt?.kind === "DIRECT")
    return (
      !!notice.intentId && order.stripePaymentIntentId === notice.intentId && !notice.sessionId
    );
  if (order.stripeCheckoutSessionId) {
    return (
      order.stripeCheckoutSessionId === notice.sessionId &&
      (!order.stripePaymentIntentId || order.stripePaymentIntentId === notice.intentId)
    );
  }
  return (
    !order.paymentAttempt && !!notice.intentId && order.stripePaymentIntentId === notice.intentId
  );
}

export function intentNotice(intent: Stripe.PaymentIntent, occurredAt = new Date()): PaymentNotice {
  return {
    orderId: intent.metadata.orderId ?? "",
    attemptId: intent.metadata.paymentAttemptId,
    intentId: intent.id,
    amountCents: intent.status === "succeeded" ? intent.amount_received : intent.amount,
    currency: intent.currency,
    livemode: intent.livemode,
    outcome: intent.status === "succeeded" ? "PAID" : "FAILED",
    occurredAt,
  };
}

export function checkoutNotice(
  session: Stripe.Checkout.Session,
  occurredAt = new Date(),
): PaymentNotice {
  return {
    orderId: session.metadata?.orderId ?? "",
    attemptId: session.metadata?.paymentAttemptId,
    sessionId: session.id,
    intentId:
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id,
    amountCents: session.amount_total ?? -1,
    currency: session.currency ?? "",
    livemode: session.livemode,
    outcome: session.payment_status === "paid" ? "PAID" : "FAILED",
    occurredAt,
  };
}

/** Mongo pipeline preserves progress and timestamps at write time, even if a
 *  staff update races a payment notification. */
export function paidUpdate(notice: PaymentNotice, hasAttempt: boolean) {
  return [
    {
      $set: {
        paymentStatus: "PAID",
        status: { $cond: [{ $in: ["$status", ["DRAFT", "AWAITING_PAYMENT"]] }, "PAID", "$status"] },
        "customerTimeline.paymentSuccessfulAt": {
          $ifNull: ["$customerTimeline.paymentSuccessfulAt", notice.occurredAt],
        },
        "customerTimeline.orderReceivedAt": {
          $ifNull: ["$customerTimeline.orderReceivedAt", notice.occurredAt],
        },
        ...(notice.intentId ? { stripePaymentIntentId: notice.intentId } : {}),
        ...(hasAttempt ? { "paymentAttempt.state": "SUCCEEDED" } : {}),
      },
    },
  ];
}

/** Caller supplies a transaction for webhook event deduplication; all other
 *  callers get the same atomic paid state + idempotent deliveries. */
export async function recordPayment(
  notice: PaymentNotice,
  session?: ClientSession,
): Promise<boolean> {
  if (!mongoose.isValidObjectId(notice.orderId)) return false;
  if (!session) {
    return mongoose.connection.transaction((transaction) => recordPayment(notice, transaction));
  }
  const order = await Order.findById(
    notice.orderId,
    {
      amountCents: 1,
      currency: 1,
      paymentStatus: 1,
      stripePaymentIntentId: 1,
      stripeCheckoutSessionId: 1,
      paymentAttempt: 1,
    },
    { session },
  ).lean();
  if (!order || !matchesPayment(order, notice) || order.paymentStatus === "REFUNDED") return false;
  const filter = {
    _id: order._id,
    paymentStatus: { $nin: notice.outcome === "PAID" ? ["REFUNDED"] : ["PAID", "REFUNDED"] },
    "paymentAttempt.id": order.paymentAttempt?.id ?? { $exists: false },
    stripePaymentIntentId: order.stripePaymentIntentId ?? { $exists: false },
    stripeCheckoutSessionId: order.stripeCheckoutSessionId ?? { $exists: false },
  };
  if (notice.outcome === "FAILED") {
    // A failed event does not release the fence. An intent with a declined
    // card can still be confirmed; cancellation must be verified separately.
    await Order.updateOne(filter, { $set: { paymentStatus: "FAILED" } }, { session });
    return false;
  }
  const updated = await Order.updateOne(filter, paidUpdate(notice, !!order.paymentAttempt), {
    session,
    updatePipeline: true,
  });
  if (!updated.matchedCount) return false;
  if (order.paymentStatus !== "PAID") {
    await Order.updateOne(
      { _id: order._id },
      {
        $push: {
          auditEvents: {
            action: "payment_confirmed",
            createdAt: notice.occurredAt,
            metadata: { paymentIntentId: notice.intentId, sessionId: notice.sessionId },
          },
        },
      },
      { session },
    );
  }
  await queuePaymentDeliveries(notice.orderId, notice.occurredAt, session);
  return true;
}
