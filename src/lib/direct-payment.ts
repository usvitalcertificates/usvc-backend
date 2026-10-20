import type { Response } from "express";
import Stripe from "stripe";
import { env } from "../config/env.js";
import { Order } from "../models/order.js";
import { chargeServiceFee } from "./direct-charge.js";
import {
  ensureDirectIntent,
  processingPayment,
  reconcilePayment,
  type AttemptOrder,
} from "./payment-attempts.js";
import { recordPayment, intentNotice } from "./payment-state.js";
const stripe = new Stripe(env.STRIPE_SECRET_KEY);
/** Shared by normal submission and verified recovery; caller holds the durable fence. */
export async function completeDirectPayment(
  order: AttemptOrder,
  card: { number: string; expiry: string; securityCode: string },
  cardToken: string | undefined,
  res: Response,
) {
  // Persist an unconfirmed intent before giving Stripe any card details.
  // A process crash can then only leave this known intent to reconcile.
  let intent;
  try {
    intent = await ensureDirectIntent(stripe, order);
  } catch {
    return processingPayment();
  }
  const claimed = await Order.findOneAndUpdate(
    {
      _id: order._id,
      "paymentAttempt.id": order.paymentAttempt!.id,
      "paymentAttempt.state": "READY",
      stripePaymentIntentId: intent.id,
      paymentStatus: { $nin: ["PAID", "REFUNDED"] },
    },
    { $set: { "paymentAttempt.state": "CONFIRMING" } },
    { returnDocument: "after" },
  ).lean();
  if (!claimed) return processingPayment();
  let charge: Awaited<ReturnType<typeof chargeServiceFee>> | undefined;
  try {
    charge = await chargeServiceFee(stripe, {
      orderId: String(order._id),
      orderNumber: order.publicNumber,
      email: order.applicant?.email ?? "",
      amountCents: order.amountCents,
      card,
      cardToken: cardToken,
      paymentIntentId: intent.id,
      idempotencyKey: `usvc_payment_${order.paymentAttempt!.id}_confirm`,
    });
  } catch {
    // Lost responses are uncertain, not proof of failure. Reconciliation
    // checks the saved intent, and cancels it before permitting a new one.
  }
  if (charge && !charge.ok && charge.httpStatus === 402 && charge.code !== "invalid_card")
    await recordPayment({ ...intentNotice(intent), outcome: "FAILED", confirmedFailure: true });
  let settled: "PAID" | "RETRY" | "PENDING";
  try {
    settled = await reconcilePayment(stripe, claimed, true);
  } catch {
    return processingPayment();
  }
  if (settled === "PAID") {
    return res.status(201).json({
      id: String(order._id),
      publicNumber: order.publicNumber,
      amountCents: order.amountCents,
      openAiEventId: order.analytics?.openAiEventId ?? "",
      paid: true as const,
    });
  }
  if (settled !== "RETRY") return processingPayment();
  const failure =
    charge && !charge.ok
      ? charge
      : {
          httpStatus: 502,
          code: "processor_error",
          message: "Payment could not be processed right now. Please try again in a moment.",
        };
  await Order.updateOne(
    {
      _id: order._id,
      "paymentAttempt.id": order.paymentAttempt!.id,
      paymentStatus: "FAILED",
    },
    {
      $push: {
        auditEvents: {
          action: "payment_failed_direct",
          metadata: { code: failure.code },
          createdAt: new Date(),
        },
      },
    },
  );
  return res.status(failure.httpStatus).json({
    message: failure.message,
    ...(failure.httpStatus === 402 ? { errors: { "paymentCard.number": failure.message } } : {}),
    paymentFailureCode: failure.code,
    publicNumber: order.publicNumber,
    paid: false as const,
  });
}
