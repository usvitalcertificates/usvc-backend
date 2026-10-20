import { Router, type Request } from "express";
import mongoose from "mongoose";
import Stripe from "stripe";
import { randomInt, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { env } from "../config/env.js";
import { Order } from "../models/order.js";
import {
  RecoveryGrant,
  RecoveryChallenge,
  RecoverySession,
  RecoveryAudit,
} from "../models/recovery.js";
import {
  requireRecoveryEmail,
  recoveryHash,
  recoveryToken,
  recoveryLimit,
  newRecoveryGrant,
  queueRecoveryEmail,
  RECOVERY_MESSAGE,
} from "../lib/recovery.js";
import { ApiError } from "../middleware/errors.js";
import {
  createOrderSchema,
  validateOrderSubmission,
  pricingBreakdown,
} from "../lib/order-validation.js";
import { encryptSensitive } from "../lib/crypto.js";
import {
  newPaymentAttempt,
  reservationFilter,
  reconcilePayment,
  processingPayment,
  type AttemptOrder,
} from "../lib/payment-attempts.js";
import { completeDirectPayment } from "../lib/direct-payment.js";
import { objectId } from "../lib/staff-dashboards.js";

const stripe = new Stripe(env.STRIPE_SECRET_KEY);
async function reconcileRecovery(order: AttemptOrder) {
  try {
    return await reconcilePayment(stripe, order);
  } catch {
    return processingPayment();
  }
}
export const recoveryRouter = Router();
const cookieName = "usvc-recovery";
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
recoveryRouter.use((req, res, next) => {
  res.set({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
  });
  if (req.method !== "GET" && req.headers.origin !== new URL(env.FRONTEND_URL).origin)
    return next(new ApiError(403, "Invalid request origin."));
  try {
    requireRecoveryEmail();
    next();
  } catch (e) {
    next(e);
  }
});
async function grantFor(token: string) {
  const grant = await RecoveryGrant.findOne({
    tokenHash: recoveryHash(token),
    expiresAt: { $gt: new Date() },
    revokedAt: { $exists: false },
  }).lean();
  if (!grant)
    throw new ApiError(410, "This recovery link expired or was replaced. Request a new link.");
  return grant;
}
async function sessionFor(req: Request) {
  const token = req.headers.cookie
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  if (!token || !tokenSchema.safeParse(token).success)
    throw new ApiError(401, "Verify your email to continue.");
  const session = await RecoverySession.findOne({
    tokenHash: recoveryHash(token),
    expiresAt: { $gt: new Date() },
  }).lean();
  if (
    !session ||
    !(await RecoveryGrant.exists({
      _id: session.grantId,
      expiresAt: { $gt: new Date() },
      revokedAt: { $exists: false },
    }))
  )
    throw new ApiError(401, "Your recovery session expired. Verify your email again.");
  return session;
}
// Matches the case-insensitive email index; never put the email in a URL.
const emailCollation = { locale: "en", strength: 2 };
function emailFilter(email: string) {
  return { "applicant.email": email };
}
async function scopedOrder(req: Request) {
  const session = await sessionFor(req),
    id = objectId.parse(req.params.id);
  const order = await Order.findOne({
    _id: id,
    ...emailFilter(session.email),
    ...(session.orderId ? { _id: session.orderId } : {}),
  })
    .collation(emailCollation)
    .lean();
  if (!order || String(order._id) !== id) throw new ApiError(404, "Application not found.");
  return { session, order };
}
const eligible = {
  paymentStatus: { $in: ["PENDING", "FAILED"] },
  status: { $in: ["DRAFT", "AWAITING_PAYMENT"] },
};
function summary(order: AttemptOrder) {
  return {
    id: String(order._id),
    publicNumber: order.publicNumber,
    certificate: order.certificate,
    stateName: order.stateName,
    stateSlug: order.stateSlug,
    createdAt: order.createdAt,
    amountCents: order.amountCents,
    currency: order.currency,
    paymentStatus: order.paymentStatus,
    status: order.status,
    revision: order.applicationRevision ?? 0,
    processing:
      !["PAID", "REFUNDED"].includes(order.paymentStatus) &&
      Boolean(
        order.paymentAttempt
          ? order.paymentAttempt.state !== "FAILED"
          : order.chargeAttempts || order.stripePaymentIntentId || order.stripeCheckoutSessionId,
      ),
  };
}
function application(order: AttemptOrder) {
  return {
    ...summary(order),
    stateCode: order.stateCode,
    county: order.geo?.county,
    city: order.geo?.city,
    reason: order.reason,
    reasonOther: order.reasonOther,
    applicant: order.applicant,
    subject: order.subject,
    family: order.family,
    addresses: order.addresses,
    destinationType: order.destinationType,
    copies: order.copies,
    rush: order.rush,
    deliveryMethod: order.deliveryMethod,
    hasStoredSsn: Boolean(order.confidentialData?.ssnEnc),
  };
}
async function audit(actor: unknown, action: string, refs: unknown[]) {
  await RecoveryAudit.create({ actor: String(actor), action, references: refs.map(String) });
}
recoveryRouter.post("/request", async (req, res, next) => {
  try {
    const input = z
      .object({
        email: z
          .string()
          .trim()
          .email()
          .max(254)
          .transform((v) => v.toLowerCase()),
        publicNumber: z.string().trim().max(60).optional(),
      })
      .strict()
      .parse(req.body);
    await recoveryLimit(`request:ip:${req.ip}`, 20, 3600000);
    // Email-level throttling is deliberately indistinguishable from an unknown email.
    try {
      await recoveryLimit(`request:email:${input.email}`, 3, 3600000);
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) return res.json({ message: RECOVERY_MESSAGE });
      throw e;
    }
    const found = await Order.exists({
      ...emailFilter(input.email),
      ...eligible,
      ...(input.publicNumber ? { publicNumber: input.publicNumber } : {}),
    }).collation(emailCollation);
    if (found)
      await mongoose.connection.transaction(async (session) => {
        const { grant, token, expiresAt } = await newRecoveryGrant(
          input.email,
          "SELF",
          input.publicNumber ? found._id : undefined,
          session,
        );
        await queueRecoveryEmail(
          input.email,
          "RECOVERY_LINK",
          token,
          expiresAt,
          grant._id,
          undefined,
          session,
        );
      });
    res.json({ message: RECOVERY_MESSAGE });
  } catch (e) {
    next(e);
  }
});
recoveryRouter.post("/code", async (req, res, next) => {
  try {
    const { token } = z.object({ token: tokenSchema }).strict().parse(req.body);
    await recoveryLimit(`code:ip:${req.ip}`, 20, 3600000);
    const grant = await grantFor(token);
    await recoveryLimit(`code:grant:${grant._id}`, 1, 60000);
    await recoveryLimit(`code:email:${grant.email}`, 5, 3600000);
    // Enforce a rolling cooldown even across fixed-window boundaries.
    if (
      !(await RecoveryGrant.findOneAndUpdate(
        {
          _id: grant._id,
          $or: [
            { lastCodeAt: { $exists: false } },
            { lastCodeAt: { $lte: new Date(Date.now() - 60000) } },
          ],
        },
        { $set: { lastCodeAt: new Date() } },
      ))
    )
      throw new ApiError(429, "Wait 60 seconds before requesting another code.");
    const code = String(randomInt(100000, 1000000)),
      expiresAt = new Date(Date.now() + 600000);
    await mongoose.connection.transaction(async (session) => {
      await RecoveryChallenge.updateMany(
        { grantId: grant._id, usedAt: { $exists: false } },
        { $set: { usedAt: new Date() } },
        { session },
      );
      const [challenge] = await RecoveryChallenge.create(
        [{ grantId: grant._id, codeHash: recoveryHash(`${grant._id}:${code}`), expiresAt }],
        { session },
      );
      await queueRecoveryEmail(
        grant.email,
        "RECOVERY_CODE",
        code,
        expiresAt,
        grant._id,
        challenge._id,
        session,
      );
    });
    res.json({
      message: "A verification code has been sent to the email saved on your application.",
    });
  } catch (e) {
    next(e);
  }
});
recoveryRouter.post("/verify", async (req, res, next) => {
  try {
    const { token, code } = z
      .object({ token: tokenSchema, code: z.string().regex(/^\d{6}$/) })
      .strict()
      .parse(req.body);
    await recoveryLimit(`verify:ip:${req.ip}`, 40, 600000);
    const grant = await grantFor(token);
    await recoveryLimit(`verify:grant:${grant._id}`, 15, 600000);
    await recoveryLimit(`verify:email:${grant.email}`, 30, 600000);
    const challenge = await RecoveryChallenge.findOneAndUpdate(
      {
        grantId: grant._id,
        expiresAt: { $gt: new Date() },
        usedAt: { $exists: false },
        attempts: { $lt: 5 },
      },
      { $inc: { attempts: 1 } },
      { returnDocument: "after", sort: { createdAt: -1 } },
    )
      .select("+codeHash")
      .lean();
    if (
      !challenge ||
      !timingSafeEqual(
        Buffer.from(challenge.codeHash, "hex"),
        Buffer.from(recoveryHash(`${grant._id}:${code}`), "hex"),
      )
    )
      throw new ApiError(400, "The code is incorrect or expired. Request a new code if needed.");
    const claimed = await RecoveryChallenge.updateOne(
      { _id: challenge._id, usedAt: { $exists: false } },
      { $set: { usedAt: new Date() } },
    );
    if (!claimed.modifiedCount) throw new ApiError(400, "This code was already used.");
    const secret = recoveryToken();
    await RecoverySession.create({
      tokenHash: recoveryHash(secret),
      grantId: grant._id,
      email: grant.email,
      orderId: grant.orderId,
      expiresAt: new Date(Date.now() + 1800000),
    });
    await audit(grant._id, "recovery_verified", [grant._id]);
    res.cookie(cookieName, secret, {
      httpOnly: true,
      secure: env.NODE_ENV !== "test",
      sameSite: "strict",
      path: "/api/backend/recovery",
      maxAge: 1800000,
    });
    res.json({ verified: true });
  } catch (e) {
    next(e);
  }
});
recoveryRouter.get("/applications", async (req, res, next) => {
  try {
    const { after } = z.object({ after: objectId.optional() }).strict().parse(req.query);
    const session = await sessionFor(req);
    const orders = await Order.find({
      ...emailFilter(session.email),
      ...(session.orderId ? { _id: session.orderId } : {}),
      ...(session.orderId ? {} : { $or: [eligible, { paymentStatus: "PAID" }] }),
      ...(after ? { $and: [{ _id: { $lt: after } }] } : {}),
    })
      .collation(emailCollation)
      .sort({ _id: -1 })
      .limit(26)
      .lean();
    await audit(
      session.grantId,
      "recovery_list",
      orders.map((o: AttemptOrder) => o._id),
    );
    res.json({
      applications: orders.slice(0, 25).map(summary),
      nextCursor: orders.length > 25 ? String(orders[24]._id) : null,
    });
  } catch (e) {
    next(e);
  }
});
recoveryRouter.get("/applications/:id", async (req, res, next) => {
  try {
    const { session, order } = await scopedOrder(req);
    if (order.paymentStatus === "REFUNDED")
      throw new ApiError(409, "Refunded applications cannot be reopened.");
    await audit(session.grantId, "recovery_view", [order._id]);
    res.json(order.paymentStatus === "PAID" ? summary(order) : application(order));
  } catch (e) {
    next(e);
  }
});
recoveryRouter.post("/applications/:id/status", async (req, res, next) => {
  try {
    z.object({}).strict().parse(req.body);
    const { order } = await scopedOrder(req);
    const state = await reconcileRecovery(order);
    res.json({
      ...summary(order),
      paid: state === "PAID",
      processing: state === "PENDING",
      retryAllowed: state === "RETRY" && ["DRAFT", "AWAITING_PAYMENT"].includes(order.status),
    });
  } catch (e) {
    next(e);
  }
});
const submitSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    application: z.record(z.string(), z.unknown()),
  })
  .strict();
async function updateApplication(req: Request, pay: boolean, res: import("express").Response) {
  const { session, order } = await scopedOrder(req);
  if (order.paymentStatus === "PAID")
    return res
      .status(409)
      .json({ message: "This order is already paid.", orderId: String(order._id) });
  if (order.paymentStatus === "REFUNDED")
    throw new ApiError(409, "Refunded applications cannot be reopened.");
  const body = submitSchema.parse(req.body),
    raw = body.application;
  if (
    raw.stateSlug !== order.stateSlug ||
    raw.stateCode !== order.stateCode ||
    raw.stateName !== order.stateName ||
    raw.certificate !== order.certificate ||
    (raw.applicant as { email?: string })?.email !== order.applicant.email
  )
    throw new ApiError(
      422,
      "Certificate, state and contact email cannot be changed. Contact support for help.",
    );
  const input = createOrderSchema.parse(raw);
  const storedSsn = !input.requestorSsn && Boolean(order.confidentialData?.ssnEnc);
  const validation = validateOrderSubmission(input, { requireCard: pay, storedSsn });
  if (!validation.ok)
    return res
      .status(422)
      .json({ message: "Please correct the highlighted fields.", errors: validation.errors });
  const state = await reconcileRecovery(order);
  if (state === "PAID")
    return res
      .status(409)
      .json({ message: "This order is already paid.", orderId: String(order._id) });
  if (state !== "RETRY") return processingPayment();
  // Reconciliation may have terminalized an attempt; reload before the guarded write.
  const current = await Order.findById(order._id).lean();
  if (!current) throw new ApiError(404, "Application not found.");
  const pricing = pricingBreakdown(
    input.copies,
    input.rush,
    input.destinationType === "international",
  );
  const fields: Record<string, unknown> = {
    geo: { county: input.county, city: input.city },
    reason: input.reason,
    reasonOther: input.reasonOther ?? "",
    applicant: input.applicant,
    subject: input.subject,
    family: input.family,
    addresses: input.addresses,
    destinationType: input.destinationType,
    copies: input.copies,
    rush: input.rush,
    deliveryMethod: input.deliveryMethod,
    pricing: { ...pricing, chargedNowCents: pricing.totalCents },
    amountCents: pricing.totalCents,
  };
  if (input.requestorSsn)
    fields["confidentialData.ssnEnc"] = encryptSensitive(input.requestorSsn.trim());
  const attempt = newPaymentAttempt("DIRECT");
  if (pay) {
    fields.paymentAttempt = attempt;
    fields.paymentStatus = "PENDING";
    fields.signature = input.signature;
    fields.signedAt = new Date();
    fields.processingAuthorization = {
      ...input.processingAuthorization,
      acceptedAt: new Date(input.processingAuthorization.acceptedAt),
    };
    fields.consents = input.consents;
  }
  const updated = await Order.findOneAndUpdate(
    {
      ...reservationFilter(current),
      $or: [
        { applicationRevision: body.revision },
        ...(body.revision === 0 ? [{ applicationRevision: { $exists: false } }] : []),
      ],
    },
    {
      $set: fields,
      $inc: { applicationRevision: 1, ...(pay ? { chargeAttempts: 1 } : {}) },
      ...(pay ? { $unset: { stripePaymentIntentId: "", stripeCheckoutSessionId: "" } } : {}),
      $push: {
        auditEvents: {
          actorId: `recovery:${session.grantId}`,
          action: pay ? "recovery_payment_attempted" : "recovery_application_updated",
          createdAt: new Date(),
        },
      },
    },
    { returnDocument: "after" },
  ).lean();
  if (!updated)
    throw new ApiError(
      409,
      "Your application changed or payment is processing. Reload before continuing.",
    );
  await audit(
    session.grantId,
    pay ? "recovery_payment_attempted" : "recovery_application_updated",
    [order._id],
  );
  if (!pay) return res.json(application(updated));
  return completeDirectPayment(updated, input.paymentCard!, input.stripeCardToken, res);
}
recoveryRouter.patch("/applications/:id", async (req, res, next) => {
  try {
    await updateApplication(req, false, res);
  } catch (e) {
    next(e);
  }
});
recoveryRouter.post("/applications/:id/pay", async (req, res, next) => {
  try {
    await recoveryLimit(`pay:ip:${req.ip}`, 20, 900000);
    await updateApplication(req, true, res);
  } catch (e) {
    next(e);
  }
});
