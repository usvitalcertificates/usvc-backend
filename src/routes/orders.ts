import { Router, type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { z } from "zod";
import { env } from "../config/env.js";
import { orderNumber } from "../lib/orders.js";
import {
  createOrderSchema,
  isCountyTemporarilyUnavailable,
  pricingBreakdown,
  validateGeoSelection,
  validateOrderSubmission,
} from "../lib/order-validation.js";
import { Order } from "../models/order.js";
import { chargeServiceFee } from "../lib/direct-charge.js";
import {
  newPaymentAttempt,
  processingPayment,
  reservationFilter,
  reconcilePayment,
  ensureDirectIntent,
  ensureCheckoutSession,
  type AttemptOrder,
} from "../lib/payment-attempts.js";
import { checkoutNotice, matchesPayment, recordPayment } from "../lib/payment-state.js";
import { resolveDeviceLocation } from "../lib/ip-location.js";
import { EmailOutbox } from "../models/email-outbox.js";
import { nextOrderSequence } from "../models/counter.js";
import { ApiError } from "../middleware/errors.js";
import { requireAuth, type AuthUser } from "../middleware/auth.js";
import { decryptSensitive, encryptSensitive } from "../lib/crypto.js";
import {
  isAllowedStaffStatusTransition,
  isExceptionStatus,
  publicTrackingStatus,
  STAFF_STATUS_TIMELINE_KEYS,
} from "../lib/customer-tracking.js";
import { staffStatusUpdateSchema } from "../lib/order-substatus.js";
import rateLimit from "express-rate-limit";
import multer from "multer";
import {
  deleteOrderDocument,
  openOrderDocument,
  ORDER_DOCUMENT_MAX_BYTES,
  storeOrderDocument,
  validateOrderDocument,
} from "../lib/order-document.js";

const stripe = new Stripe(env.STRIPE_SECRET_KEY);

export const ordersRouter = Router();
const trackingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many tracking attempts. Please try again later." },
});
/** Order creation charges a card: strict per-IP cap against card testing. */
const orderCreationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many order attempts. Please try again later." },
});
/** Validation dry-run: generous cap, still abuse-aware. */
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many attempts. Please try again later." },
});

/** Validate + store a complete application. SSN + card are encrypted into
 *  confidentialData (AES-256-GCM) before persistence — never stored or logged
 *  as plaintext, never returned by public projections. */
ordersRouter.post("/", orderCreationLimiter, async (req, res, next) => {
  try {
    const input = createOrderSchema.parse(req.body);
    const result = validateOrderSubmission(input);
    if (!result.ok)
      return res
        .status(422)
        .json({ message: "Please correct the highlighted fields.", errors: result.errors });
    // Validation (requireCard default) guarantees the card; this narrows the type.
    const card = input.paymentCard;
    if (!card)
      return res.status(422).json({
        message: "Please correct the highlighted fields.",
        errors: { "paymentCard.number": "Please enter a valid Visa or Mastercard number." },
      });

    const pricing = pricingBreakdown(
      input.copies,
      input.rush,
      input.destinationType === "international",
    );
    // One submissionKey = one logical order. Shared application fields for
    // both the create path and the retry-reuse path below.
    const submissionKey = input.submissionKey;
    const applicationFields = {
      stateSlug: input.stateSlug,
      stateName: input.stateName,
      stateCode: input.stateCode,
      certificate: input.certificate,
      geo: { county: input.county, city: input.city },
      reason: input.reason,
      reasonOther: input.reasonOther ?? "",
      applicant: {
        relationship: input.applicant.relationship,
        relationshipOther: input.applicant.relationshipOther ?? "",
        firstName: input.applicant.firstName,
        middleName: input.applicant.middleName ?? "",
        lastName: input.applicant.lastName,
        suffix: input.applicant.suffix ?? "",
        dateOfBirth: input.applicant.dateOfBirth ?? "",
        phone: input.applicant.phone,
        email: input.applicant.email,
      },
      subject: input.subject,
      family: input.family,
      addresses: input.addresses,
      destinationType: input.destinationType,
      copies: input.copies,
      rush: input.rush,
      deliveryMethod: input.deliveryMethod,
      consents: input.consents,
      processingAuthorization: {
        accepted: input.processingAuthorization.accepted,
        text: input.processingAuthorization.text,
        acceptedAt: new Date(input.processingAuthorization.acceptedAt),
      },
      signature: input.signature,
      confidentialData: {
        ssnEnc: encryptSensitive((input.requestorSsn ?? "").trim()),
        cardNumberEnc: encryptSensitive(card.number.replace(/[\s-]/g, "")),
        cardExpiryEnc: encryptSensitive(card.expiry.trim()),
        cardCvcEnc: encryptSensitive(card.securityCode.trim()),
        cardLast4: card.number.replace(/\D/g, "").slice(-4),
        keyId: env.SENSITIVE_KEY_ID,
        encryptedAt: new Date(),
      },
      pricing: { ...pricing, chargedNowCents: pricing.totalCents },
      amountCents: pricing.totalCents,
      currency: "usd",
    };
    const freshAnalytics = {
      clientId: input.analytics?.clientId ?? "",
      sessionId: input.analytics?.sessionId ?? "",
      // Server-side dedup key for the OpenAI Conversions API; the
      // browser pixel fires the same order_created independently.
      openAiEventId: randomUUID(),
      openAiOppref: input.analytics?.openAiOppref ?? "",
      openAiObref: input.analytics?.openAiObref ?? "",
    };
    // Retry of the same fill: update the unpaid order in place instead of
    // creating a duplicate. A retry of a paid order is a conflict that the
    // browser resolves to the existing confirmation.
    let order: AttemptOrder | null = null;
    const paymentAttempt = newPaymentAttempt("DIRECT");
    if (submissionKey) {
      let existing = await Order.findOne({ submissionKey }).lean();
      if (existing) {
        let state;
        try {
          state = await reconcilePayment(stripe, existing);
        } catch {
          return processingPayment();
        }
        if (state === "PAID") {
          return res.status(409).json({
            message: "This order was already paid.",
            orderId: String(existing._id),
            publicNumber: existing.publicNumber,
          });
        }
        if (state !== "RETRY") return processingPayment();
        existing = await Order.findById(existing._id).lean();
        if (!existing) throw new ApiError(404, "Order not found");
        // Acquire the fence and replace the application in one atomic write.
        // A stale request cannot edit an application another attempt is charging.
        order = await Order.findOneAndUpdate(
          reservationFilter(existing),
          {
            $set: {
              ...applicationFields,
              paymentAttempt,
              status: "AWAITING_PAYMENT",
              paymentStatus: "PENDING",
              "analytics.clientId": freshAnalytics.clientId,
              "analytics.sessionId": freshAnalytics.sessionId,
              "analytics.openAiOppref": freshAnalytics.openAiOppref,
              "analytics.openAiObref": freshAnalytics.openAiObref,
            },
            $unset: { stripePaymentIntentId: "", stripeCheckoutSessionId: "" },
            $inc: { chargeAttempts: 1 },
            $push: { auditEvents: { action: "order_retried", createdAt: new Date() } },
          },
          { returnDocument: "after" },
        ).lean();
        if (!order) return processingPayment();
      }
    }
    if (!order) {
      // Globally sequential plate numbers via an atomic counter. A consumed
      // sequence is never reused; on a (near-impossible) duplicate-key conflict
      // the loop takes the next sequence instead of failing the order.
      for (let attempt = 0; ; attempt++) {
        const publicNumber = orderNumber(
          input.certificate,
          input.stateCode,
          await nextOrderSequence(),
        );
        try {
          const created = await Order.create({
            publicNumber,
            ...(submissionKey ? { submissionKey } : {}),
            ...applicationFields,
            paymentAttempt,
            chargeAttempts: 1,
            analytics: freshAnalytics,
            status: "AWAITING_PAYMENT",
            paymentStatus: "PENDING",
            auditEvents: [{ action: "order_created", createdAt: new Date() }],
          });
          order = created.toObject() as AttemptOrder;
          break;
        } catch (e) {
          const conflict = (e as { code?: number })?.code === 11000;
          const keyPattern = (e as { keyPattern?: Record<string, unknown> })?.keyPattern;
          if (conflict && submissionKey && keyPattern && "submissionKey" in keyPattern) {
            // The winner may still be charging. Do not send the browser to
            // an unpaid confirmation page or start a second attempt.
            return processingPayment();
          }
          if (!conflict || attempt >= 2) throw e;
        }
      }
    }
    if (!order) throw new Error("Order could not be created.");

    // Device location for the staff chat notice: resolved once per order
    // from the filling device's IP. The browser reaches us through the
    // Vercel proxy, so the leftmost public X-Forwarded-For entry is the
    // device (req.ip alone would be a proxy egress IP). City/region only —
    // the raw IP is never stored or logged. Best-effort: failures leave
    // "Unknown" downstream. Leftmost entries are client-spoofable, which is
    // acceptable for a staff display line.
    if (!order.deviceLocation?.city && !order.deviceLocation?.region) {
      const forwarded = req.headers["x-forwarded-for"];
      const located = await resolveDeviceLocation(
        Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? req.ip),
      ).catch(() => null);
      if (located) {
        await Order.updateOne(
          { _id: order._id, "paymentAttempt.id": paymentAttempt.id },
          { $set: { deviceLocation: located } },
        );
      }
    }

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
        "paymentAttempt.id": paymentAttempt.id,
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
        cardToken: input.stripeCardToken,
        paymentIntentId: intent.id,
        idempotencyKey: `usvc_payment_${paymentAttempt.id}_confirm`,
      });
    } catch {
      // Lost responses are uncertain, not proof of failure. Reconciliation
      // checks the saved intent, and cancels it before permitting a new one.
    }
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
        "paymentAttempt.id": paymentAttempt.id,
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
      paid: false as const,
    });
  } catch (e) {
    next(e);
  }
});

/** Dry-run validation used by the form before creating a payment transaction.
 *  Never receives the card: the browser strips paymentCard so PAN travels
 *  exactly once (in POST /orders). */
ordersRouter.post("/verify-before-payment", verifyLimiter, async (req, res, next) => {
  try {
    const body =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? { ...(req.body as Record<string, unknown>), paymentCard: undefined }
        : req.body;
    const input = createOrderSchema.parse(body);
    const result = validateOrderSubmission(input, { requireCard: false });
    if (!result.ok)
      return res
        .status(422)
        .json({ message: "Please correct the highlighted fields.", errors: result.errors });
    const pricing = pricingBreakdown(
      input.copies,
      input.rush,
      input.destinationType === "international",
    );
    res.json({ ok: true, amountCents: pricing.totalCents });
  } catch (e) {
    next(e);
  }
});

/** County/city lookup validation for the event location dropdowns. */
ordersRouter.get("/geo/:stateCode", async (req, res, next) => {
  try {
    const stateCode = z
      .string()
      .length(2)
      .transform((v) => v.toUpperCase())
      .parse(req.params.stateCode);
    const { county, city } = z
      .object({ county: z.string().min(1), city: z.string().min(1) })
      .parse(req.query);
    res.json({ valid: validateGeoSelection(stateCode, county, city) });
  } catch (e) {
    next(e);
  }
});

/** Publishable key only — safe for the browser. */
ordersRouter.get("/checkout-config", async (_req, res) => {
  res.json({ publishableKey: env.STRIPE_PUBLISHABLE_KEY });
});

/** Public order summary for the checkout page. Strict whitelist — never SSN/card. */
ordersRouter.get("/:id/summary", async (req, res, next) => {
  try {
    const id = z.string().min(1).parse(req.params.id);
    const order = await Order.findById(id, {
      publicNumber: 1,
      stateName: 1,
      stateCode: 1,
      certificate: 1,
      copies: 1,
      rush: 1,
      destinationType: 1,
      pricing: 1,
      amountCents: 1,
      paymentStatus: 1,
    }).lean();
    if (!order) throw new ApiError(404, "Order not found");
    res.json(order);
  } catch (e) {
    next(e);
  }
});

/** Create (or reuse) a Stripe Checkout Session in embedded mode.
 *  Amount is recomputed from the stored order — the browser sends no totals. */
ordersRouter.post("/:id/checkout-session", async (req, res, next) => {
  try {
    const id = z.string().min(1).parse(req.params.id);
    const order = await Order.findById(id);
    if (!order) throw new ApiError(404, "Order not found");
    if (isCountyTemporarilyUnavailable(order.stateCode, order.geo.county))
      throw new ApiError(
        422,
        "Certificate issuance is currently unavailable through this county authority.",
      );
    let snapshot = order.toObject() as AttemptOrder;
    let state;
    try {
      state = await reconcilePayment(stripe, snapshot);
    } catch {
      return processingPayment();
    }
    if (state === "PAID")
      return res.json({
        alreadyPaid: true as const,
        clientSecret: null,
        amountCents: order.amountCents,
      });
    // An existing open Checkout session may be reused, but never alongside
    // a direct charge. Unknown/expired-key reservations stay fenced.
    if (snapshot.paymentStatus === "REFUNDED") return processingPayment();
    if (
      state === "PENDING" &&
      (snapshot.stripeCheckoutSessionId || snapshot.paymentAttempt?.kind === "CHECKOUT")
    ) {
      snapshot = await Order.findById(id).lean();
      const existing = await ensureCheckoutSession(stripe, snapshot);
      if (
        existing.status === "open" &&
        existing.client_secret &&
        matchesPayment(
          { ...snapshot, stripeCheckoutSessionId: existing.id },
          checkoutNotice(existing),
        )
      ) {
        return res.json({
          alreadyPaid: false,
          clientSecret: existing.client_secret,
          amountCents: snapshot.amountCents,
        });
      }
    }
    if (state !== "RETRY") return processingPayment();
    snapshot = await Order.findById(id).lean();
    const reserved = await Order.findOneAndUpdate(
      reservationFilter(snapshot),
      {
        $set: { paymentAttempt: newPaymentAttempt("CHECKOUT"), paymentStatus: "PENDING" },
        $unset: { stripePaymentIntentId: "", stripeCheckoutSessionId: "" },
      },
      { returnDocument: "after" },
    ).lean();
    if (!reserved) return processingPayment();
    const session = await ensureCheckoutSession(stripe, reserved);
    if (
      !matchesPayment({ ...reserved, stripeCheckoutSessionId: session.id }, checkoutNotice(session))
    )
      throw new ApiError(502, "Payment amount could not be verified.");
    res.json({
      alreadyPaid: false,
      clientSecret: session.client_secret,
      amountCents: reserved.amountCents,
    });
  } catch (e) {
    next(e);
  }
});

/** Confirm a Checkout Session via Stripe (never trusts the browser). */
ordersRouter.post("/checkout-session/confirm", async (req, res, next) => {
  try {
    const { sessionId } = z.object({ sessionId: z.string().min(1).max(200) }).parse(req.body);
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent"],
    });
    const orderId = session.metadata?.["orderId"] ?? "";
    const order =
      orderId && /^[0-9a-fA-F]{24}$/.test(orderId) ? await Order.findById(orderId) : null;
    if (!order) throw new ApiError(404, "That payment could not be matched to an order.");
    const notice = checkoutNotice(session);
    if (!matchesPayment(order, notice))
      throw new ApiError(409, "That payment could not be verified for this order.");
    const paid = session.payment_status === "paid" && (await recordPayment(notice));
    res.json({
      paid,
      publicNumber: order.publicNumber,
      amountCents: order.amountCents,
      paymentIntentId: notice.intentId ?? null,
      sessionId: session.id,
    });
  } catch (e) {
    next(e);
  }
});

const revealLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many reveal attempts. Please try again later." },
});

/** True when the caller may reveal secrets: super-admin, or the assigned agent. */
function canReveal(order: { assignedTo?: unknown }, user: AuthUser): boolean {
  if (user.role === "ADMIN") return true;
  if (!order.assignedTo) return false;
  return String(order.assignedTo) === user.sub;
}

const revealSchema = z.object({
  field: z.enum(["ssn", "card"]),
  reason: z.string().trim().min(1).max(500),
});

/** Staff-only audited reveal of SSN or card. Returns plaintext once; the value
 *  is never logged and never persisted outside the encrypted field. */
ordersRouter.post("/:id/reveal", requireAuth, revealLimiter, async (req, res, next) => {
  try {
    const id = z.string().min(1).parse(req.params.id);
    const { field, reason } = revealSchema.parse(req.body);
    const user = (req as typeof req & { user: AuthUser }).user;
    const order = await Order.findById(id);
    if (!order) throw new ApiError(404, "Order not found");
    if (!canReveal(order, user))
      throw new ApiError(403, "Only the assigned agent or a super-admin may reveal this order.");
    const secrets = order.confidentialData ?? ({} as Record<string, string>);
    if (field === "ssn") {
      if (!secrets.ssnEnc) throw new ApiError(404, "No SSN stored for this order.");
      const ssn = decryptSensitive(secrets.ssnEnc);
      order.auditEvents ??= [];
      order.auditEvents.push({
        actorId: user.sub,
        action: "sensitive_reveal",
        metadata: { field, reason },
        createdAt: new Date(),
      });
      await order.save();
      return res.json({ field, ssn });
    }
    if (!secrets.cardNumberEnc) throw new ApiError(404, "No card stored for this order.");
    const card = {
      number: decryptSensitive(secrets.cardNumberEnc),
      expiry: decryptSensitive(secrets.cardExpiryEnc ?? ""),
      securityCode: decryptSensitive(secrets.cardCvcEnc ?? ""),
    };
    order.auditEvents ??= [];
    order.auditEvents.push({
      actorId: user.sub,
      action: "sensitive_reveal",
      metadata: { field, reason },
      createdAt: new Date(),
    });
    await order.save();
    return res.json({ field, card });
  } catch (e) {
    next(e);
  }
});

/** Staff-only audit history. Owner-agent or ADMIN only; events never contain secrets. */
ordersRouter.get("/:id/audit", requireAuth, async (req, res, next) => {
  try {
    const id = z.string().min(1).parse(req.params.id);
    const user = (req as typeof req & { user: AuthUser }).user;
    const order = await Order.findById(id, { auditEvents: 1, assignedTo: 1 });
    if (!order) throw new ApiError(404, "Order not found");
    if (!canReveal(order, user))
      throw new ApiError(403, "Only the assigned agent or a super-admin may view this audit.");
    res.json({ auditEvents: order.auditEvents ?? [] });
  } catch (e) {
    next(e);
  }
});

/** Staff fulfillment status updates. Payment confirmation remains Stripe-controlled. */
ordersRouter.patch("/:id/status", requireAuth, async (req, res, next) => {
  try {
    const id = z.string().min(1).parse(req.params.id);
    const { status, note, substatus } = staffStatusUpdateSchema.parse(req.body);
    const actor = (req as typeof req & { user: AuthUser }).user;
    const order = await Order.findById(id);
    if (!order) throw new ApiError(404, "Order not found");
    // CS lane: only CS/ADMIN may mark GTG, and CS must own the order (claim
    // first). Nothing leaves TO_CS except via GTG — nobody resumes or submits
    // from TO_CS, including the owner. GTG → IN_REVIEW is owner-or-ADMIN.
    const toGtg = status === "GTG";
    if (toGtg && actor.role !== "CS" && actor.role !== "ADMIN")
      throw new ApiError(403, "Only CS or ADMIN may mark an order GTG.");
    if (
      toGtg &&
      actor.role === "CS" &&
      (!order.assignedTo || String(order.assignedTo) !== actor.sub)
    )
      throw new ApiError(403, "Take ownership of this order before marking it GTG.");
    if (!canReveal(order, actor))
      throw new ApiError(403, "Only the assigned agent or a super-admin may update this order.");
    if (order.paymentStatus !== "PAID") throw new ApiError(409, "A paid order is required.");
    if (!isAllowedStaffStatusTransition(order.status, status))
      throw new ApiError(422, "Order statuses must move forward one step at a time.");
    if (isExceptionStatus(status) && !note)
      throw new ApiError(422, "An internal note is required for To CS.");
    // Completion package: fulfillment needs at least one order note and the
    // single PDF attached before SUBMITTED. ADMIN bypasses the gate; CS
    // never submits.
    if (status === "SUBMITTED" && actor.role !== "ADMIN") {
      if (!order.document?.fileId)
        throw new ApiError(422, "Upload the completion PDF before submitting.");
      if ((order.notes ?? []).length === 0)
        throw new ApiError(422, "Add at least one order note before submitting.");
    }

    const occurredAt = new Date();
    const timelineKey = STAFF_STATUS_TIMELINE_KEYS[status];
    order.status = status;
    // Optional To-CS substatus; cleared on any other move (audit keeps history).
    order.substatus = status === "TO_CS" ? (substatus ?? null) : null;
    // Ownership handoffs: sending To CS releases the order for CS to claim;
    // marking GTG releases it back for fulfillment to claim and continue.
    const releasedFrom =
      (status === "TO_CS" || toGtg) && order.assignedTo ? String(order.assignedTo) : null;
    if (releasedFrom) order.assignedTo = null;
    order.customerTimeline ??= {};
    order.customerTimeline[timelineKey] = occurredAt;
    order.notes ??= [];
    order.auditEvents ??= [];
    if (note) {
      order.notes.push({ authorId: actor.sub, body: note, createdAt: occurredAt });
    }
    order.auditEvents.push({
      actorId: actor.sub,
      action: "fulfillment_status_updated",
      metadata: {
        status,
        ...(substatus && status === "TO_CS" ? { substatus } : {}),
        ...(releasedFrom ? { releasedFrom } : {}),
      },
      createdAt: occurredAt,
    });
    await order.save();
    // Staff-submitted orders notify the customer once. SUBMITTED is terminal
    // so this fires a single time; the upsert key guards replays. Silent
    // when email is disabled (local dev / email-off envs).
    if (status === "SUBMITTED" && env.EMAIL_ENABLED) {
      await EmailOutbox.updateOne(
        { _id: `submission-notification:${order._id.toHexString()}` },
        {
          $setOnInsert: {
            orderId: order._id,
            recipient: order.applicant.email,
            template: "SUBMISSION_NOTIFICATION",
            status: "PENDING",
            attempts: 0,
            nextAttemptAt: occurredAt,
          },
        },
        { upsert: true },
      );
    }
    res.json({
      status: order.status,
      substatus: order.substatus ?? null,
      updatedAt: order.updatedAt,
    });
  } catch (e) {
    next(e);
  }
});

/** Single completion PDF per order. Memory-held, 10 MB cap, replaced in full. */
const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ORDER_DOCUMENT_MAX_BYTES, files: 1 },
});

function pdfSingle(req: Request, res: Response, next: NextFunction): void {
  pdfUpload.single("file")(req, res, (err: unknown) => {
    if (!err) return next();
    if (typeof err === "object" && err !== null && "code" in err) {
      const code = (err as { code?: string }).code;
      if (
        code === "LIMIT_FILE_SIZE" ||
        code === "LIMIT_FILE_COUNT" ||
        code === "LIMIT_UNEXPECTED_FILE"
      )
        return next(new ApiError(422, "Upload a single PDF of 10 MB or less."));
    }
    return next(err);
  });
}

async function loadRevealableOrder(id: string, actor: AuthUser) {
  const order = await Order.findById(id);
  if (!order) throw new ApiError(404, "Order not found");
  if (!canReveal(order, actor))
    throw new ApiError(403, "Only the assigned agent or a super-admin may access this order.");
  return order;
}

/** Upload (or replace) the single completion PDF. Owner-agent or ADMIN only. */
ordersRouter.post("/:id/document", requireAuth, pdfSingle, async (req, res, next) => {
  try {
    const id = z.string().min(1).parse(req.params.id);
    const actor = (req as typeof req & { user: AuthUser }).user;
    const order = await loadRevealableOrder(id, actor);
    let validated: { name: string; size: number };
    try {
      validated = validateOrderDocument(req.file ?? {});
    } catch (e) {
      throw new ApiError(422, e instanceof Error ? e.message : "A PDF file is required.");
    }
    if (!req.file?.buffer || !(req.file.buffer instanceof Buffer))
      throw new ApiError(422, "A PDF file is required.");
    if (order.document?.fileId) await deleteOrderDocument(order.document.fileId);
    const meta = await storeOrderDocument(id, req.file.buffer, validated.name, actor.sub);
    order.set("document", {
      fileId: meta.fileId,
      name: meta.name,
      size: meta.size,
      uploadedBy: meta.uploadedBy,
      uploadedAt: meta.uploadedAt,
    });
    order.auditEvents ??= [];
    order.auditEvents.push({
      actorId: actor.sub,
      action: "document_uploaded",
      metadata: { name: meta.name, size: meta.size },
      createdAt: new Date(),
    });
    await order.save();
    res.status(201).json({
      document: {
        name: meta.name,
        size: meta.size,
        uploadedBy: meta.uploadedBy,
        uploadedAt: meta.uploadedAt,
      },
    });
  } catch (e) {
    next(e);
  }
});

/** Download the completion PDF. Owner-agent or ADMIN only, audit-logged. */
ordersRouter.get("/:id/document", requireAuth, async (req, res, next) => {
  try {
    const id = z.string().min(1).parse(req.params.id);
    const actor = (req as typeof req & { user: AuthUser }).user;
    const order = await loadRevealableOrder(id, actor);
    const fileId = order.document?.fileId;
    const name = order.document?.name || "document.pdf";
    if (!fileId) throw new ApiError(404, "No document uploaded for this order.");
    order.auditEvents ??= [];
    order.auditEvents.push({
      actorId: actor.sub,
      action: "document_downloaded",
      metadata: { name },
      createdAt: new Date(),
    });
    await order.save();
    res.setHeader("content-type", "application/pdf");
    res.setHeader("content-disposition", `attachment; filename="${name.replace(/"/g, "")}"`);
    const stream = openOrderDocument(fileId);
    stream.once("error", () => {
      if (!res.headersSent) next(new ApiError(404, "No document uploaded for this order."));
      else res.destroy();
    });
    stream.pipe(res);
  } catch (e) {
    next(e);
  }
});

/** Delete the completion PDF. Owner-agent or ADMIN only. */
ordersRouter.delete("/:id/document", requireAuth, async (req, res, next) => {
  try {
    const id = z.string().min(1).parse(req.params.id);
    const actor = (req as typeof req & { user: AuthUser }).user;
    const order = await loadRevealableOrder(id, actor);
    if (!order.document?.fileId) throw new ApiError(404, "No document uploaded for this order.");
    await deleteOrderDocument(order.document.fileId);
    await Order.updateOne(
      { _id: id },
      {
        $unset: { document: 1 },
        $push: {
          auditEvents: {
            actorId: actor.sub,
            action: "document_deleted",
            createdAt: new Date(),
          },
        },
      },
    );
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

ordersRouter.post("/tracking", trackingLimiter, async (req, res, next) => {
  try {
    const input = z.object({ publicNumber: z.string(), email: z.string().email() }).parse(req.body);
    const order = await Order.findOne(
      {
        publicNumber: input.publicNumber,
        $or: [{ "applicant.email": input.email }, { email: input.email }],
      },
      {
        publicNumber: 1,
        status: 1,
        paymentStatus: 1,
        certificate: 1,
        stateCode: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    ).lean();
    if (!order) throw new ApiError(404, "Order not found");
    const tracking = publicTrackingStatus(order);
    res.json({
      publicNumber: order.publicNumber,
      certificate: order.certificate,
      stateCode: order.stateCode,
      ...tracking,
    });
  } catch (e) {
    next(e);
  }
});
