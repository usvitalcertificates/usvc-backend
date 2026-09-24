import { Router } from "express";
import Stripe from "stripe";
import { z } from "zod";
import { env } from "../config/env.js";
import { orderNumber, priceOrder } from "../lib/orders.js";
import {
  createOrderSchema,
  isCountyTemporarilyUnavailable,
  pricingBreakdown,
  validateGeoSelection,
  validateOrderSubmission,
} from "../lib/order-validation.js";
import { Order } from "../models/order.js";
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
import rateLimit from "express-rate-limit";

const stripe = new Stripe(env.STRIPE_SECRET_KEY);

export const ordersRouter = Router();
const trackingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many tracking attempts. Please try again later." },
});

/** Validate + store a complete application. SSN + card are encrypted into
 *  confidentialData (AES-256-GCM) before persistence — never stored or logged
 *  as plaintext, never returned by public projections. */
ordersRouter.post("/", async (req, res, next) => {
  try {
    const input = createOrderSchema.parse(req.body);
    const result = validateOrderSubmission(input);
    if (!result.ok)
      return res
        .status(422)
        .json({ message: "Please correct the highlighted fields.", errors: result.errors });

    const pricing = pricingBreakdown(
      input.copies,
      input.rush,
      input.destinationType === "international",
    );
    // Globally sequential plate numbers via an atomic counter. A consumed
    // sequence is never reused; on a (near-impossible) duplicate-key conflict
    // the loop takes the next sequence instead of failing the order.
    let order;
    for (let attempt = 0; ; attempt++) {
      const publicNumber = orderNumber(
        input.certificate,
        input.stateCode,
        await nextOrderSequence(),
      );
      try {
        order = await Order.create({
          publicNumber,
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
            cardNumberEnc: encryptSensitive(input.paymentCard.number.replace(/[\s-]/g, "")),
            cardExpiryEnc: encryptSensitive(input.paymentCard.expiry.trim()),
            cardCvcEnc: encryptSensitive(input.paymentCard.securityCode.trim()),
            keyId: env.SENSITIVE_KEY_ID,
            encryptedAt: new Date(),
          },
          analytics: {
            clientId: input.analytics?.clientId ?? "",
            sessionId: input.analytics?.sessionId ?? "",
          },
          pricing: { ...pricing, chargedNowCents: pricing.totalCents },
          amountCents: pricing.totalCents,
          currency: "usd",
          status: "AWAITING_PAYMENT",
          paymentStatus: "PENDING",
          auditEvents: [{ action: "order_created", createdAt: new Date() }],
        });
        break;
      } catch (e) {
        const conflict = (e as { code?: number })?.code === 11000;
        if (!conflict || attempt >= 2) throw e;
      }
    }
    if (!order) throw new Error("Order could not be created.");

    res.status(201).json({
      id: order._id.toHexString(),
      publicNumber: order.publicNumber,
      amountCents: order.amountCents,
    });
  } catch (e) {
    next(e);
  }
});

/** Dry-run validation used by the form before creating a payment transaction. */
ordersRouter.post("/verify-before-payment", async (req, res, next) => {
  try {
    const input = createOrderSchema.parse(req.body);
    const result = validateOrderSubmission(input);
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
    if (order.paymentStatus === "PAID")
      return res.json({
        alreadyPaid: true as const,
        clientSecret: null,
        amountCents: order.amountCents,
      });

    const international = order.destinationType === "international";
    const amountCents = priceOrder(order.copies, order.rush, international);

    // Reuse an open session so a retried payment does not create duplicates.
    if (order.stripeCheckoutSessionId) {
      try {
        const existing = await stripe.checkout.sessions.retrieve(order.stripeCheckoutSessionId);
        if (
          existing.status === "open" &&
          existing.amount_total === amountCents &&
          existing.client_secret
        ) {
          return res.json({
            alreadyPaid: false as const,
            clientSecret: existing.client_secret,
            amountCents,
          });
        }
      } catch {
        /* Fall through and create a fresh session. */
      }
    }

    const certLabel = order.certificate.charAt(0) + order.certificate.slice(1).toLowerCase();
    // Two-fee model: Stripe charges the Online Processing Fee (+ rush) only.
    // Government / agency / shipping fees are charged separately later via the
    // encrypted stored card — they never appear in this session.
    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        ui_mode: "elements",
        customer_email: order.applicant.email,
        return_url: `${env.FRONTEND_URL}/order/confirmation/${order._id.toHexString()}?session_id={CHECKOUT_SESSION_ID}`,
        line_items: [
          {
            quantity: order.copies,
            price_data: {
              currency: "usd",
              unit_amount: 12500,
              product_data: {
                name: `${order.stateName} ${certLabel} Certificate — Online Processing Fee`,
              },
            },
          },
          ...(order.rush
            ? [
                {
                  quantity: 1,
                  price_data: {
                    currency: "usd",
                    unit_amount: 3000,
                    product_data: { name: "Rush Processing" },
                  },
                },
              ]
            : []),
        ],
        metadata: {
          orderId: order._id.toHexString(),
          orderNumber: order.publicNumber,
          certificate: order.certificate,
          state: order.stateName,
          copies: String(order.copies),
          rush: order.rush ? "true" : "false",
        },
        payment_intent_data: {
          description: `USVC ${order.publicNumber} — Complete Order Payment`,
          metadata: { orderId: order._id.toHexString(), orderNumber: order.publicNumber },
        },
      },
      { idempotencyKey: `usvc_checkout_${order._id.toHexString()}` },
    );

    if (session.amount_total !== amountCents)
      throw new ApiError(502, "Payment amount could not be verified.");
    order.stripeCheckoutSessionId = session.id;
    await order.save();
    res.json({ alreadyPaid: false as const, clientSecret: session.client_secret, amountCents });
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
    const intent = typeof session.payment_intent === "string" ? null : session.payment_intent;
    const paymentIntentId =
      typeof session.payment_intent === "string" ? session.payment_intent : (intent?.id ?? null);
    if (session.payment_status === "paid") {
      order.paymentStatus = "PAID";
      order.status = "PAID";
      order.amountCents = session.amount_total ?? order.amountCents;
      if (paymentIntentId) order.stripePaymentIntentId = paymentIntentId;
      order.stripeCheckoutSessionId = session.id;
      order.auditEvents.push({
        action: "payment_confirmed",
        metadata: { sessionId: session.id },
        createdAt: new Date(),
      });
      await order.save();
      return res.json({
        paid: true as const,
        publicNumber: order.publicNumber,
        amountCents: order.amountCents,
        paymentIntentId,
        sessionId: session.id,
      });
    }
    order.auditEvents.push({
      action: "payment_failed",
      metadata: { sessionId: session.id, status: session.status },
      createdAt: new Date(),
    });
    await order.save();
    res.json({
      paid: false as const,
      publicNumber: order.publicNumber,
      amountCents: order.amountCents,
      paymentIntentId,
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

const staffStatusSchema = z.object({
  status: z.enum(["IN_REVIEW", "TO_CS", "GTG", "SUBMITTED"]),
  // Required when sending an order To CS; kept internal only. Optional for GTG.
  note: z.string().trim().min(1).max(2000).optional(),
});
/** Staff fulfillment status updates. Payment confirmation remains Stripe-controlled. */
ordersRouter.patch("/:id/status", requireAuth, async (req, res, next) => {
  try {
    const id = z.string().min(1).parse(req.params.id);
    const { status, note } = staffStatusSchema.parse(req.body);
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

    const occurredAt = new Date();
    const timelineKey = STAFF_STATUS_TIMELINE_KEYS[status];
    order.status = status;
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
      metadata: releasedFrom ? { status, releasedFrom } : { status },
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
    res.json({ status: order.status, updatedAt: order.updatedAt });
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
