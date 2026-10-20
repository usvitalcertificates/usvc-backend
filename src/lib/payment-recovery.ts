import mongoose, { type ClientSession } from "mongoose";
import Stripe from "stripe";
import { env } from "../config/env.js";
import { Order } from "../models/order.js";
import { EmailOutbox } from "../models/email-outbox.js";
import { encryptSensitive, decryptSensitive } from "./crypto.js";
import { newRecoveryGrant, RECOVERY_LINK_TTL_MS } from "./recovery.js";
import { RecoveryGrant } from "../models/recovery.js";
import { matchesPayment, intentNotice, checkoutNotice } from "./payment-state.js";
import { renderPaymentRecoveryEmail } from "./payment-recovery-email.js";

export const PAYMENT_RECOVERY_DELAY_MS = 2 * 60_000;
const stripe = new Stripe(env.STRIPE_SECRET_KEY);

/** Called only inside the guarded failure transaction. Missing eligibility on
 * historical attempts is deliberately false. The order marker survives job TTL. */
export async function schedulePaymentRecovery(
  orderId: string,
  attemptId: string | undefined,
  session: ClientSession,
) {
  if (!env.EMAIL_ENABLED || !attemptId) return;
  const scheduledAt = new Date();
  const order = await Order.findOneAndUpdate(
    {
      _id: orderId,
      paymentStatus: "FAILED",
      status: { $in: ["DRAFT", "AWAITING_PAYMENT"] },
      "paymentAttempt.id": attemptId,
      "paymentAttempt.recoveryEmailEligible": true,
      paymentRecoveryEmail: { $exists: false },
    },
    {
      $set: { paymentRecoveryEmail: { scheduledAt, outcome: "QUEUED" } },
      $push: { auditEvents: { action: "payment_recovery_email_queued", createdAt: scheduledAt } },
    },
    { session, returnDocument: "after" },
  ).lean();
  if (!order?.applicant?.email) return;
  await EmailOutbox.create(
    [
      {
        _id: `payment_recovery_${orderId}`,
        orderId,
        recipient: order.applicant.email,
        template: "PAYMENT_RECOVERY",
        recoveryScheduledAt: scheduledAt,
        nextAttemptAt: new Date(scheduledAt.getTime() + PAYMENT_RECOVERY_DELAY_MS),
      },
    ],
    { session },
  );
}

export async function recoveryEmailOutcome(
  orderId: unknown,
  outcome: "SENT" | "SKIPPED" | "FAILED",
  session?: ClientSession,
) {
  await Order.updateOne(
    { _id: orderId, "paymentRecoveryEmail.outcome": "QUEUED" },
    {
      $set: { "paymentRecoveryEmail.outcome": outcome },
      $push: {
        auditEvents: {
          action: `payment_recovery_email_${outcome.toLowerCase()}`,
          createdAt: new Date(),
        },
      },
    },
    { session },
  );
}

/** Stripe reads only: delivery never reconciles, cancels, charges or settles. */
async function currentFailure(order: any): Promise<"SEND" | "DEFER" | "SKIP"> {
  if (
    ["PAID", "REFUNDED"].includes(order.paymentStatus) ||
    !["DRAFT", "AWAITING_PAYMENT"].includes(order.status)
  )
    return "SKIP";
  if (!order.paymentAttempt?.recoveryEmailEligible) return "SKIP";
  if (order.stripeCheckoutSessionId) {
    const checkout = await stripe.checkout.sessions.retrieve(order.stripeCheckoutSessionId);
    if (!matchesPayment(order, checkoutNotice(checkout))) return "DEFER";
    if (checkout.payment_status === "paid") return "SKIP";
    const id =
      typeof checkout.payment_intent === "string"
        ? checkout.payment_intent
        : checkout.payment_intent?.id;
    if (!id) return "DEFER";
    const intent = await stripe.paymentIntents.retrieve(id);
    if (
      intent.metadata.orderId !== String(order._id) ||
      intent.metadata.paymentAttemptId !== order.paymentAttempt.id ||
      intent.amount !== order.amountCents ||
      intent.currency.toLowerCase() !== order.currency.toLowerCase() ||
      intent.livemode !== (env.PAYMENT_ENVIRONMENT === "live")
    )
      return "DEFER";
    if (intent.status === "succeeded") return "SKIP";
    if (
      ["requires_payment_method", "canceled"].includes(intent.status) &&
      intent.last_payment_error
    )
      return "SEND";
    return "DEFER";
  }
  if (!order.stripePaymentIntentId) return "DEFER";
  const intent = await stripe.paymentIntents.retrieve(order.stripePaymentIntentId);
  if (!matchesPayment(order, intentNotice(intent))) return "DEFER";
  if (intent.status === "succeeded") return "SKIP";
  if (
    intent.status === "canceled" ||
    (intent.status === "requires_payment_method" && intent.last_payment_error)
  )
    return "SEND";
  return "DEFER";
}

export async function preparePaymentRecovery(message: any) {
  const now = new Date();
  const lease = { _id: message._id, status: "SENDING", attempts: message.attempts };
  let order = await Order.findById(message.orderId).lean();
  let decision: "SEND" | "DEFER" | "SKIP" = "SKIP";
  if (
    order &&
    message.recoveryScheduledAt &&
    now.getTime() < message.recoveryScheduledAt.getTime() + RECOVERY_LINK_TTL_MS
  ) {
    try {
      decision = await currentFailure(order);
    } catch {
      decision = "DEFER";
    }
  }
  if (decision === "DEFER") {
    await EmailOutbox.updateOne(lease, {
      $set: { status: "PENDING", nextAttemptAt: new Date(now.getTime() + 60_000) },
      $inc: { attempts: -1 },
      $unset: { leaseExpiresAt: 1 },
    });
    return null;
  }
  if (decision === "SKIP" || !order) {
    await mongoose.connection.transaction(async (session) => {
      const result = await EmailOutbox.updateOne(
        lease,
        {
          $set: { status: "SKIPPED" },
          $unset: { leaseExpiresAt: 1, recoverySecret: 1, recoveryContent: 1 },
        },
        { session },
      );
      if (result.modifiedCount) await recoveryEmailOutcome(message.orderId, "SKIPPED", session);
    });
    return null;
  }
  // Grant + encrypted delivery secret commit together. A provider retry uses
  // the persisted grant and never extends its original issuance expiry.
  const checkedAttemptId = order.paymentAttempt?.id;
  const checkedIntentId = order.stripePaymentIntentId;
  const checkedSessionId = order.stripeCheckoutSessionId;
  await mongoose.connection.transaction(async (session) => {
    const current = await EmailOutbox.findOne(lease)
      .select("+recoverySecret +recoveryContent")
      .session(session)
      .lean();
    if (!current) throw new Error("Recovery email lease lost");
    order = await Order.findById(message.orderId).session(session).lean();
    if (
      !order ||
      order.paymentAttempt?.id !== checkedAttemptId ||
      order.stripePaymentIntentId !== checkedIntentId ||
      order.stripeCheckoutSessionId !== checkedSessionId ||
      ["PAID", "REFUNDED"].includes(order.paymentStatus) ||
      !["DRAFT", "AWAITING_PAYMENT"].includes(order.status)
    )
      throw new Error("Recovery order changed");
    if (!current.recoverySecret) {
      const recovery = await newRecoveryGrant(
        order.applicant.email,
        "AUTOMATIC",
        order._id,
        session,
      );
      const saved = {
        recoverySecret: encryptSensitive(recovery.token),
        recoveryContent: encryptSensitive(
          JSON.stringify(
            renderPaymentRecoveryEmail(
              {
                firstName: order.applicant.firstName,
                publicNumber: order.publicNumber,
                stateName: order.stateName,
                certificate: order.certificate,
                url: recovery.url,
              },
              env.FRONTEND_URL,
            ),
          ),
        ),
        recoveryGrantId: recovery.grant._id,
        recoveryExpiresAt: recovery.expiresAt,
      };
      await EmailOutbox.updateOne(lease, { $set: saved }, { session });
      Object.assign(message, saved);
    } else
      Object.assign(message, {
        recoverySecret: current.recoverySecret,
        recoveryContent: current.recoveryContent,
        recoveryGrantId: current.recoveryGrantId,
        recoveryExpiresAt: current.recoveryExpiresAt,
      });
  });
  if (
    !message.recoveryExpiresAt ||
    message.recoveryExpiresAt <= now ||
    !(await RecoveryGrant.exists({
      _id: message.recoveryGrantId,
      revokedAt: { $exists: false },
      expiresAt: { $gt: now },
    }))
  )
    throw new Error("Recovery email expired");
  return JSON.parse(decryptSensitive(message.recoveryContent)) as {
    subject: string;
    html: string;
    text: string;
  };
}

/** TTL may remove a prepared job while the worker is offline. Its permanent
 * marker still prevents requeue; close the audit outcome when processing resumes. */
export async function expireOrphanedPaymentRecoveries() {
  const cutoff = new Date(Date.now() - RECOVERY_LINK_TTL_MS);
  const orders = await Order.find(
    {
      "paymentRecoveryEmail.outcome": "QUEUED",
      "paymentRecoveryEmail.scheduledAt": { $lte: cutoff },
    },
    { _id: 1 },
  )
    .limit(100)
    .lean();
  for (const order of orders) {
    await mongoose.connection.transaction(async (session) => {
      if (!(await EmailOutbox.exists({ _id: `payment_recovery_${order._id}` }).session(session)))
        await recoveryEmailOutcome(order._id, "SKIPPED", session);
    });
  }
}
