import mongoose from "mongoose";
import { RecoveryGrant, RecoverySession, RecoveryChallenge } from "../models/recovery.js";
import { newRecoveryGrant, requireRecoveryEmail } from "../lib/recovery.js";
import { OUTREACH_OUTCOMES } from "../lib/outreach.js";
import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireActiveStaff } from "../middleware/auth.js";
import { ApiError } from "../middleware/errors.js";
import { Order, type OrderDoc } from "../models/order.js";
import { StaffUser } from "../models/staff.js";
import {
  auditDashboard,
  dashboardUser,
  dateBounds,
  dateOnly,
  objectId,
  requireAdminOrCs,
} from "../lib/staff-dashboards.js";

export const unpaidOrdersRouter = Router();
unpaidOrdersRouter.use(requireAuth, requireActiveStaff, requireAdminOrCs);
unpaidOrdersRouter.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
const searchSchema = z
  .object({
    search: z.string().trim().max(120).optional(),
    paymentStatus: z.enum(["PENDING", "FAILED", "REFUNDED"]).optional(),
    certificate: z.enum(["BIRTH", "DEATH", "MARRIAGE", "DIVORCE"]).optional(),
    outcome: z.enum(OUTREACH_OUTCOMES).optional(),
    from: dateOnly.optional(),
    to: dateOnly.optional(),
    page: z.number().int().min(1).max(100_000).default(1),
  })
  .strict()
  .refine((v) => !v.from || !v.to || v.from <= v.to, "Invalid date range");
const projection = {
  publicNumber: 1,
  certificate: 1,
  stateCode: 1,
  stateName: 1,
  "applicant.firstName": 1,
  "applicant.lastName": 1,
  "applicant.email": 1,
  "applicant.phone": 1,
  createdAt: 1,
  amountCents: 1,
  currency: 1,
  paymentStatus: 1,
  status: 1,
  "outreach.outcome": 1,
  "outreach.updatedAt": 1,
  "paymentAttempt.state": 1,
};
type ContactOrder = Pick<
  OrderDoc,
  | "publicNumber"
  | "certificate"
  | "stateCode"
  | "stateName"
  | "applicant"
  | "createdAt"
  | "amountCents"
  | "currency"
  | "paymentStatus"
  | "status"
  | "outreach"
  | "paymentAttempt"
> & { _id: unknown };
export function unpaidRow(order: ContactOrder) {
  return {
    id: String(order._id),
    publicNumber: order.publicNumber,
    certificate: order.certificate,
    stateCode: order.stateCode,
    stateName: order.stateName,
    customerName: [order.applicant?.firstName, order.applicant?.lastName].filter(Boolean).join(" "),
    email: order.applicant?.email ?? "",
    phone: order.applicant?.phone ?? "",
    createdAt: order.createdAt,
    amountCents: order.amountCents,
    currency: order.currency,
    paymentStatus: order.paymentStatus ?? "PENDING",
    status: order.status,
    outcome: order.outreach?.outcome ?? "NOT_CONTACTED",
    followUpUpdatedAt: order.outreach?.updatedAt ?? null,
    unresolved:
      !!order.paymentAttempt && !["FAILED", "SUCCEEDED"].includes(order.paymentAttempt.state),
  };
}

unpaidOrdersRouter.post("/search", async (req, res, next) => {
  try {
    const input = searchSchema.parse(req.body);
    const match: Record<string, unknown> = {
      paymentStatus: input.paymentStatus ?? { $ne: "PAID" },
    };
    if (input.certificate) match.certificate = input.certificate;
    if (input.from || input.to) match.createdAt = dateBounds(input.from, input.to);
    if (input.outcome === "NOT_CONTACTED") {
      match.$or = [
        { "outreach.outcome": "NOT_CONTACTED" },
        { "outreach.outcome": { $exists: false } },
      ];
    } else if (input.outcome) match["outreach.outcome"] = input.outcome;
    if (input.search) {
      const term = input.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const alternatives: Record<string, unknown>[] = [
        "publicNumber",
        "applicant.firstName",
        "applicant.lastName",
        "applicant.email",
        "applicant.phone",
      ].map((field) => ({ [field]: { $regex: term, $options: "i" } }));
      alternatives.push({
        $expr: {
          $regexMatch: {
            input: {
              $concat: [
                { $ifNull: ["$applicant.firstName", ""] },
                " ",
                { $ifNull: ["$applicant.lastName", ""] },
              ],
            },
            regex: term,
            options: "i",
          },
        },
      });
      if (/^[+\d() .-]+$/.test(input.search) && input.search.replace(/\D/g, "").length >= 4)
        alternatives.push({ "applicant.phone": { $regex: input.search.replace(/\D/g, "") } });
      match.$and = [{ $or: alternatives }];
    }
    const [result] = await Order.aggregate([
      { $match: match },
      {
        $facet: {
          orders: [
            { $sort: { createdAt: -1, _id: -1 } },
            { $skip: (input.page - 1) * 25 },
            { $limit: 25 },
            { $project: projection },
          ],
          counts: [{ $group: { _id: "$paymentStatus", count: { $sum: 1 } } }],
        },
      },
    ]);
    const orders = result.orders.map(unpaidRow);
    const counts: Record<string, number> = {};
    for (const row of result.counts)
      counts[row._id ?? "PENDING"] = (counts[row._id ?? "PENDING"] ?? 0) + row.count;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    await auditDashboard(
      req,
      "unpaid_orders_viewed",
      orders.map((o: { id: string }) => o.id),
    );
    res.json({
      orders,
      total,
      counts,
      page: input.page,
      pages: Math.max(1, Math.ceil(total / 25)),
    });
  } catch (error) {
    next(error);
  }
});

unpaidOrdersRouter.get("/:id", async (req, res, next) => {
  try {
    const id = objectId.parse(req.params.id);
    // Retain outreach history after conversion, but the detail becomes read-only.
    const order = await Order.findById(id, { ...projection, "outreach.entries": 1 }).lean();
    if (!order) throw new ApiError(404, "Order not found.");
    const entries = order.outreach?.entries ?? [];
    const authors = await StaffUser.find(
      { _id: { $in: entries.map((e: any) => e.authorId) } },
      { fullName: 1 },
    ).lean();
    const names = new Map(authors.map((a: any) => [String(a._id), a.fullName || "Staff"]));
    await auditDashboard(req, "unpaid_order_viewed", [id]);
    res.json({
      order: unpaidRow(order),
      history: entries
        .map((entry: any) => ({
          id: String(entry._id),
          note: entry.note,
          outcome: entry.outcome ?? null,
          author: names.get(String(entry.authorId)) ?? "Staff",
          createdAt: entry.createdAt,
        }))
        .reverse(),
    });
  } catch (error) {
    next(error);
  }
});

unpaidOrdersRouter.post("/:id/follow-ups", async (req, res, next) => {
  try {
    const id = objectId.parse(req.params.id);
    const input = z
      .object({
        note: z.string().trim().max(2000).default(""),
        outcome: z.enum(OUTREACH_OUTCOMES).optional(),
      })
      .strict()
      .refine((v) => !!v.note || !!v.outcome, "Enter a note or select an outcome.")
      .parse(req.body);
    const actorId = dashboardUser(req).sub;
    const now = new Date();
    const result = await Order.updateOne(
      { _id: id, paymentStatus: { $ne: "PAID" } },
      {
        $set: {
          ...(input.outcome ? { "outreach.outcome": input.outcome } : {}),
          "outreach.updatedAt": now,
          "outreach.updatedBy": actorId,
        },
        $push: {
          "outreach.entries": {
            authorId: actorId,
            note: input.note,
            outcome: input.outcome,
            createdAt: now,
          },
          auditEvents: {
            actorId,
            action: "outreach_updated",
            metadata: input.outcome ? { outcome: input.outcome } : {},
            createdAt: now,
          },
        },
      },
      { runValidators: true },
    );
    if (!result.matchedCount) {
      const exists = await Order.exists({ _id: id });
      throw new ApiError(
        exists ? 409 : 404,
        exists ? "This order is now paid. Refresh the unpaid-orders list." : "Order not found.",
      );
    }
    res.status(201).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// Staff can share a private link, but cannot bypass customer email verification.
unpaidOrdersRouter.post("/:id/resume-link", async (req, res, next) => {
  try {
    requireRecoveryEmail();
    const id = objectId.parse(req.params.id);
    z.object({}).strict().parse(req.body);
    let result;
    await mongoose.connection.transaction(async (session) => {
      const order = await Order.findOne({
        _id: id,
        paymentStatus: { $in: ["PENDING", "FAILED"] },
        status: { $in: ["DRAFT", "AWAITING_PAYMENT"] },
      })
        .session(session)
        .lean();
      if (!order)
        throw new ApiError(409, "Only unpaid starting orders can be resumed. Refresh this order.");
      const prior = await RecoveryGrant.find({
        orderId: id,
        source: "STAFF",
        revokedAt: { $exists: false },
      })
        .session(session)
        .distinct("_id");
      await RecoveryGrant.updateMany(
        { _id: { $in: prior } },
        { $set: { revokedAt: new Date() } },
        { session },
      );
      await RecoverySession.deleteMany({ grantId: { $in: prior } }, { session });
      await RecoveryChallenge.deleteMany({ grantId: { $in: prior } }, { session });
      const created = await newRecoveryGrant(order.applicant.email, "STAFF", order._id, session);
      result = { url: created.url, expiresAt: created.expiresAt };
      // Touch the order so concurrent payment/state changes conflict with generation.
      await Order.updateOne(
        { _id: id },
        {
          $push: {
            auditEvents: {
              actorId: dashboardUser(req).sub,
              action: "resume_link_generated",
              createdAt: new Date(),
            },
          },
        },
        { session },
      );
    });
    await auditDashboard(req, "resume_link_generated", [id]);
    res.json(result);
  } catch (e) {
    next(e);
  }
});
