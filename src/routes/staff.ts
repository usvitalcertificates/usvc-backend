import { Router } from "express";
import type { Request } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { requireActiveStaff, requireAuth, type AuthUser } from "../middleware/auth.js";
import { ApiError } from "../middleware/errors.js";
import { Order } from "../models/order.js";
import { StaffUser } from "../models/staff.js";

export const staffRouter = Router();
staffRouter.use(requireAuth, requireActiveStaff);

const reqUser = (req: Request): AuthUser => {
  const user = (req as Request & { user?: AuthUser }).user;
  if (!user) throw new ApiError(401, "Authentication required");
  return user;
};

interface QueueRow {
  _id: unknown;
  publicNumber: string;
  certificate: string;
  stateCode: string;
  geo?: { county?: string };
  applicant: { firstName: string; lastName: string };
  copies: number;
  rush: boolean;
  status: string;
  assignedTo?: unknown;
  createdAt?: Date;
}

const orderEvent = (actorId: string, action: string, metadata?: Record<string, unknown>) => ({
  actorId,
  action,
  metadata,
  createdAt: new Date(),
});

/**
 * Fulfillment queue. Agents see paid unassigned orders plus their own work;
 * super-admins see everything. List rows are masked: names are truncated to
 * first + last initial and contact/PII fields are excluded entirely.
 */
staffRouter.get("/orders", async (req, res, next) => {
  try {
    const filters = z
      .object({
        search: z.string().trim().max(120).optional(),
        status: z.enum(["PAID", "IN_REVIEW", "ON_HOLD", "NEED_INFO", "SUBMITTED"]).optional(),
        certificate: z.enum(["BIRTH", "DEATH", "MARRIAGE", "DIVORCE"]).optional(),
        assigned: z.enum(["mine", "unassigned", "all"]).default("all"),
        openOnly: z.coerce.boolean().default(false),
        // Parked exceptions first, then rush, then oldest (My Work default).
        attentionFirst: z.coerce.boolean().default(false),
        rushOnly: z.coerce.boolean().default(false),
        page: z.coerce.number().int().min(1).default(1),
      })
      .parse(req.query);
    const user = reqUser(req);
    const match: Record<string, unknown> = { paymentStatus: "PAID" };
    if (filters.status) match.status = filters.status;
    else if (filters.openOnly)
      match.status = { $in: ["PAID", "IN_REVIEW", "ON_HOLD", "NEED_INFO"] };
    if (filters.rushOnly) match.rush = true;
    if (filters.certificate) match.certificate = filters.certificate;
    if (user.role === "ADMIN") {
      if (filters.assigned === "mine") match.assignedTo = user.sub;
      else if (filters.assigned === "unassigned") match.assignedTo = null;
    } else if (filters.assigned === "mine") {
      match.assignedTo = user.sub;
    } else if (filters.assigned === "unassigned") {
      match.assignedTo = null;
    } else {
      match.$or = [{ assignedTo: null }, { assignedTo: user.sub }];
    }
    if (filters.search) {
      const term = filters.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      match.$and = (match.$and as unknown[] | undefined) ?? [];
      (match.$and as unknown[]).push({
        $or: [
          { publicNumber: { $regex: term, $options: "i" } },
          { "applicant.firstName": { $regex: term, $options: "i" } },
          { "applicant.lastName": { $regex: term, $options: "i" } },
          { "applicant.email": { $regex: term, $options: "i" } },
        ],
      });
    }
    const limit = 25;
    const skip = (filters.page - 1) * limit;
    const projection = {
      publicNumber: 1,
      stateCode: 1,
      stateName: 1,
      certificate: 1,
      geo: 1,
      "applicant.firstName": 1,
      "applicant.lastName": 1,
      copies: 1,
      rush: 1,
      status: 1,
      assignedTo: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    let rows: QueueRow[];
    if (filters.attentionFirst) {
      // Aggregation skips Mongoose casting, so assignedTo hex strings are
      // converted to ObjectIds explicitly. Priority mirrors
      // attentionPriority() in customer-tracking.ts.
      const toId = (value: unknown): unknown =>
        typeof value === "string" && /^[0-9a-fA-F]{24}$/.test(value)
          ? new mongoose.Types.ObjectId(value)
          : value;
      const aggregateMatch: Record<string, unknown> = { ...match };
      if ("assignedTo" in aggregateMatch)
        aggregateMatch.assignedTo = toId(aggregateMatch.assignedTo);
      if (Array.isArray(aggregateMatch.$or))
        aggregateMatch.$or = (aggregateMatch.$or as Record<string, unknown>[]).map((clause) =>
          "assignedTo" in clause ? { ...clause, assignedTo: toId(clause.assignedTo) } : clause,
        );
      rows = await Order.aggregate([
        { $match: aggregateMatch },
        {
          $addFields: {
            __priority: {
              $cond: [
                { $in: ["$status", ["ON_HOLD", "NEED_INFO"]] },
                0,
                { $cond: ["$rush", 1, 2] },
              ],
            },
          },
        },
        { $sort: { __priority: 1, createdAt: 1 } },
        { $skip: skip },
        { $limit: limit },
        { $project: projection },
        { $unset: "__priority" },
      ]);
    } else {
      rows = (await Order.find(match, projection)
        .sort({ createdAt: 1 })
        .skip(skip)
        .limit(limit)
        .lean()) as QueueRow[];
    }
    const total = await Order.countDocuments(match);
    const ownerIds = [
      ...new Set(
        rows
          .map((row: QueueRow) => row.assignedTo)
          .filter(Boolean)
          .map(String),
      ),
    ];
    const owners: { _id: unknown; fullName?: string }[] = await StaffUser.find(
      { _id: { $in: ownerIds } },
      { fullName: 1 },
    ).lean();
    const ownerNames = new Map(
      owners.map((owner: { _id: unknown; fullName?: string }) => [
        String(owner._id),
        owner.fullName || "Staff",
      ]),
    );
    res.json({
      orders: rows.map((row: QueueRow) => ({
        id: String(row._id),
        publicNumber: row.publicNumber,
        certificate: row.certificate,
        stateCode: row.stateCode,
        county: row.geo?.county ?? "",
        // Masked requestor: first name + last initial only until claimed.
        requestor:
          row.assignedTo && String(row.assignedTo) === user.sub
            ? `${row.applicant.firstName} ${row.applicant.lastName}`
            : `${row.applicant.firstName} ${row.applicant.lastName.charAt(0)}.`,
        copies: row.copies,
        rush: row.rush,
        status: row.status,
        assignedToMe: !!row.assignedTo && String(row.assignedTo) === user.sub,
        assignedName: row.assignedTo ? (ownerNames.get(String(row.assignedTo)) ?? "Staff") : null,
        createdAt: row.createdAt,
      })),
      total,
      page: filters.page,
      pages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (e) {
    next(e);
  }
});

/**
 * Claim an order. Atomic: exactly one agent wins even under concurrency.
 * Only paid, unassigned orders can be claimed.
 */
staffRouter.post("/orders/:id/claim", async (req, res, next) => {
  try {
    const id = z.string().min(1).parse(req.params.id);
    const user = reqUser(req);
    const order = await Order.findOneAndUpdate(
      { _id: id, assignedTo: null, paymentStatus: "PAID" },
      {
        $set: { assignedTo: user.sub },
        $push: { auditEvents: orderEvent(user.sub, "order_claimed") },
      },
      { new: true, projection: { publicNumber: 1, status: 1 } },
    );
    if (!order) {
      const existing = await Order.findById(id, { assignedTo: 1, paymentStatus: 1 }).lean();
      if (!existing) throw new ApiError(404, "Order not found");
      if (existing.assignedTo) throw new ApiError(409, "This order was already claimed.");
      throw new ApiError(409, "Only paid orders can be claimed.");
    }
    res.json({ ok: true, publicNumber: order.publicNumber, status: order.status });
  } catch (e) {
    next(e);
  }
});

/** Owner releases back to the queue, or super-admin releases any order. */
staffRouter.post("/orders/:id/release", async (req, res, next) => {
  try {
    const id = z.string().min(1).parse(req.params.id);
    const user = reqUser(req);
    const order = await Order.findById(id, { assignedTo: 1 }).lean();
    if (!order) throw new ApiError(404, "Order not found");
    if (user.role !== "ADMIN" && String(order.assignedTo ?? "") !== user.sub)
      throw new ApiError(403, "Only the assigned agent or a super-admin may release this order.");
    // Atomic $set/$push: the doc is loaded with a projection, so save() here
    // would overwrite the unselected notes/auditEvents arrays.
    await Order.updateOne(
      { _id: id },
      {
        $set: { assignedTo: null },
        $push: { auditEvents: orderEvent(user.sub, "order_released") },
      },
    );
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/** Super-admin moves an order directly to another agent. */
staffRouter.post("/orders/:id/reassign", async (req, res, next) => {
  try {
    const id = z.string().min(1).parse(req.params.id);
    const { staffId } = z.object({ staffId: z.string().min(1) }).parse(req.body);
    const user = reqUser(req);
    if (user.role !== "ADMIN") throw new ApiError(403, "Super-admin access required");
    const member = await StaffUser.findById(staffId, { accountStatus: 1 });
    if (!member || member.accountStatus !== "active")
      throw new ApiError(422, "Orders can only be reassigned to an active staff account.");
    const order = await Order.findById(id, { assignedTo: 1 }).lean();
    if (!order) throw new ApiError(404, "Order not found");
    // Atomic $set/$push: the doc is loaded with a projection, so save() here
    // would overwrite the unselected notes/auditEvents arrays.
    await Order.updateOne(
      { _id: id },
      {
        $set: { assignedTo: member._id },
        $push: { auditEvents: orderEvent(user.sub, "order_reassigned", { staffId }) },
      },
    );
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/**
 * Full operational detail. Owner-agent or super-admin only. SSN/card stay
 * masked (`*********`) — use POST /orders/:id/reveal for audited access.
 */
staffRouter.get("/orders/:id", async (req, res, next) => {
  try {
    const id = z.string().min(1).parse(req.params.id);
    const user = reqUser(req);
    const order = await Order.findById(id, { confidentialData: 0 }).lean();
    if (!order) throw new ApiError(404, "Order not found");
    const owner = order.assignedTo ? String(order.assignedTo) : null;
    if (user.role !== "ADMIN" && owner !== user.sub)
      throw new ApiError(403, "Only the assigned agent or a super-admin may open this order.");
    const assignee = owner
      ? await StaffUser.findById(owner, { fullName: 1, email: 1 }).lean()
      : null;
    res.json({
      ...order,
      _id: String(order._id),
      assignedTo: owner,
      assignedName: assignee?.fullName || (owner ? "Staff" : null),
      ssn: "*********",
      card: { number: "*********", expiry: "*********", securityCode: "*********" },
    });
  } catch (e) {
    next(e);
  }
});

/** Internal notes. Never shown to the customer. */
staffRouter.post("/orders/:id/notes", async (req, res, next) => {
  try {
    const id = z.string().min(1).parse(req.params.id);
    const { body } = z.object({ body: z.string().trim().min(1).max(2000) }).parse(req.body);
    const user = reqUser(req);
    const order = await Order.findById(id, { assignedTo: 1 }).lean();
    if (!order) throw new ApiError(404, "Order not found");
    const owner = order.assignedTo ? String(order.assignedTo) : null;
    if (user.role !== "ADMIN" && owner !== user.sub)
      throw new ApiError(403, "Only the assigned agent or a super-admin may add notes.");
    const occurredAt = new Date();
    // Atomic $push: the doc is loaded with a projection, so save() here
    // would overwrite the unselected notes/auditEvents arrays.
    await Order.updateOne(
      { _id: id },
      {
        $push: {
          notes: { authorId: user.sub, body, createdAt: occurredAt },
          auditEvents: orderEvent(user.sub, "internal_note_added"),
        },
      },
    );
    res.status(201).json({ ok: true });
  } catch (e) {
    next(e);
  }
});
