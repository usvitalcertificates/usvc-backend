import { Router } from "express";
import Stripe from "stripe";
import { z, ZodError } from "zod";
import rateLimit from "express-rate-limit";
import { env } from "../config/env.js";
import { requireActiveStaff, requireAuth } from "../middleware/auth.js";
import { ApiError } from "../middleware/errors.js";
import { auditDashboard, requireAdminOrCs } from "../lib/staff-dashboards.js";
import {
  stripePaymentSearch,
  stripePaymentDetail,
  stripeReference,
  stripeSearchSchema,
} from "../lib/stripe-history.js";
const stripe = new Stripe(env.STRIPE_SECRET_KEY, { timeout: 8_000, maxNetworkRetries: 0 });
export const staffPaymentsRouter = Router();
staffPaymentsRouter.use(requireAuth, requireActiveStaff, requireAdminOrCs);
staffPaymentsRouter.use(
  rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many payment lookups. Please wait a minute." },
  }),
);
staffPaymentsRouter.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
function safeError(error: unknown) {
  if (error instanceof ApiError || error instanceof ZodError) return error;
  if ((error as { code?: string })?.code === "resource_missing")
    return new ApiError(404, "Stripe payment not found.");
  // Never log/return Stripe errors: they may contain customer data or request details.
  return new ApiError(
    503,
    "Stripe payment history is unavailable. Try again; payment status has not been confirmed.",
  );
}
staffPaymentsRouter.post("/search", async (req, res, next) => {
  try {
    const input = stripeSearchSchema.parse(req.body);
    const result = await stripePaymentSearch(stripe, input);
    await auditDashboard(
      req,
      "stripe_payments_viewed",
      result.payments.map((payment) => payment.id),
    );
    res.json(result);
  } catch (error) {
    next(safeError(error));
  }
});
staffPaymentsRouter.get("/:reference", async (req, res, next) => {
  try {
    const reference = stripeReference.parse(req.params.reference);
    const query = z
      .object({
        attemptAfter: z
          .string()
          .regex(/^ch_[a-zA-Z0-9_-]{1,200}$/)
          .optional(),
        refundAfter: z
          .string()
          .regex(/^re_[a-zA-Z0-9_-]{1,200}$/)
          .optional(),
      })
      .strict()
      .parse(req.query);
    const result = await stripePaymentDetail(stripe, reference, query);
    await auditDashboard(req, "stripe_payment_viewed", [reference]);
    res.json(result);
  } catch (error) {
    next(safeError(error));
  }
});
