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
import { ApiError } from "../middleware/errors.js";

const stripe = new Stripe(env.STRIPE_SECRET_KEY);

export const ordersRouter = Router();

/** Validate + store a complete application, SSN included as plaintext on the
 *  order document per owner requirement. SSN must never be returned by public
 *  projections — staff-authorized reads only. */
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
    const order = await Order.create({
      publicNumber: orderNumber(input.certificate),
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
      requestorSsn: (input.requestorSsn ?? "").trim(),
      paymentCard: {
        number: input.paymentCard.number.replace(/[\s-]/g, ""),
        expiry: input.paymentCard.expiry.trim(),
        securityCode: input.paymentCard.securityCode.trim(),
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
    // stored card — they never appear in this session.
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

ordersRouter.post("/tracking", async (req, res, next) => {
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
    res.json(order);
  } catch (e) {
    next(e);
  }
});
