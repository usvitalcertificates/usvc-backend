import { Router } from "express";
import type { Request } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { requireActiveStaff, requireAuth, type AuthUser } from "../middleware/auth.js";
import { ApiError } from "../middleware/errors.js";
import { encryptSensitive } from "../lib/crypto.js";
import { env } from "../config/env.js";
import { queueAssignmentMatch } from "../lib/staff-queue.js";
import {
  isPlausibleSsn,
  validateCorrection,
  type CorrectionCandidate,
} from "../lib/order-validation.js";
import { canCorrectOrders, canSeePricing } from "../lib/staff-roles.js";
import { Order } from "../models/order.js";
import { StaffUser } from "../models/staff.js";

export const staffRouter = Router();
staffRouter.use(requireAuth, requireActiveStaff);

/**
 * Strict query-flag parsing. Unlike z.coerce.boolean() (where ANY non-empty
 * string, including "false" or "no", becomes true), only explicit truthy
 * tokens enable the flag — anything else is safely off.
 */
const staffFlag = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((value) => value === "true" || value === "1");

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
 * Fulfillment queue. Every role sees all paid orders (CS corrects across
 * owners, fulfillment sees who claimed what); rows stay masked for non-owners
 * and every action stays gated. The `assigned` filter narrows to mine or
 * unassigned. Contact/PII fields are excluded entirely.
 */
staffRouter.get("/orders", async (req, res, next) => {
  try {
    const filters = z
      .object({
        search: z.string().trim().max(120).optional(),
        status: z.enum(["PAID", "IN_REVIEW", "TO_CS", "GTG", "SUBMITTED"]).optional(),
        certificate: z.enum(["BIRTH", "DEATH", "MARRIAGE", "DIVORCE"]).optional(),
        assigned: z.enum(["mine", "unassigned", "all"]).default("all"),
        openOnly: staffFlag,
        // Parked-for-CS first, then rush, then oldest (My Work default).
        attentionFirst: staffFlag,
        rushOnly: staffFlag,
        page: z.coerce.number().int().min(1).default(1),
      })
      .parse(req.query);
    const user = reqUser(req);
    const match: Record<string, unknown> = { paymentStatus: "PAID" };
    if (filters.status) match.status = filters.status;
    else if (filters.openOnly) match.status = { $in: ["PAID", "IN_REVIEW", "TO_CS", "GTG"] };
    if (filters.rushOnly) match.rush = true;
    if (filters.certificate) match.certificate = filters.certificate;
    Object.assign(match, queueAssignmentMatch(filters.assigned, user.sub));
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
              $cond: [{ $in: ["$status", ["TO_CS", "GTG"]] }, 0, { $cond: ["$rush", 1, 2] }],
            },
          },
        },
        { $sort: { __priority: 1, updatedAt: -1 } },
        { $skip: skip },
        { $limit: limit },
        { $project: projection },
        { $unset: "__priority" },
      ]);
    } else {
      // Default: most recently active first in every list view.
      rows = (await Order.find(match, projection)
        .sort({ updatedAt: -1 })
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
      { returnDocument: "after", projection: { publicNumber: 1, status: 1 } },
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
 * Full operational detail. Owner-agent, CS, or ADMIN. SSN/card stay
 * masked (`*********`) — use POST /orders/:id/reveal for audited access.
 * Pricing (`pricing` + `amountCents`) is returned only to ADMIN + CS.
 */
staffRouter.get("/orders/:id", async (req, res, next) => {
  try {
    const id = z.string().min(1).parse(req.params.id);
    const user = reqUser(req);
    const order = await Order.findById(id, { confidentialData: 0 }).lean();
    if (!order) throw new ApiError(404, "Order not found");
    const owner = order.assignedTo ? String(order.assignedTo) : null;
    if (!canCorrectOrders(user.role) && owner !== user.sub)
      throw new ApiError(403, "Only the assigned agent or a super-admin may open this order.");
    const assignee = owner
      ? await StaffUser.findById(owner, { fullName: 1, email: 1 }).lean()
      : null;
    const showPricing = canSeePricing(user.role);
    const { pricing, amountCents, ...rest } = order as Record<string, unknown>;
    res.json({
      ...rest,
      ...(showPricing ? { pricing, amountCents } : {}),
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

/** Internal notes. Owner, CS, or ADMIN. Never shown to the customer. */
staffRouter.post("/orders/:id/notes", async (req, res, next) => {
  try {
    const id = z.string().min(1).parse(req.params.id);
    const { body } = z.object({ body: z.string().trim().min(1).max(2000) }).parse(req.body);
    const user = reqUser(req);
    const order = await Order.findById(id, { assignedTo: 1 }).lean();
    if (!order) throw new ApiError(404, "Order not found");
    const owner = order.assignedTo ? String(order.assignedTo) : null;
    if (!canCorrectOrders(user.role) && owner !== user.sub)
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

/**
 * CS correction (EDIT-only, no create/delete). CS claims the order first,
 * then fixes the whole application form here (ADMIN may edit without owning).
 * Closed (SUBMITTED) orders are read-only. Copies/rush/certificate/state/pricing
 * are never editable here (payment already taken). SSN/card replacements are
 * encrypted into confidentialData and audited by field name only — values
 * never logged.
 */
const addressCorrection = z
  .object({
    firstName: z.string().trim().max(120).optional(),
    lastName: z.string().trim().max(120).optional(),
    line1: z.string().trim().max(200).optional(),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().max(120).optional(),
    state: z.string().trim().max(120).optional(),
    postalCode: z.string().trim().max(20).optional(),
    country: z.string().trim().max(120).optional(),
  })
  .strict();

const paymentCardCorrection = z
  .object({
    number: z.string().trim().max(24),
    expiry: z.string().trim().max(7),
    securityCode: z.string().trim().max(5),
  })
  .strict();

export const correctionSchema = z
  .object({
    applicant: z
      .object({
        relationship: z.string().trim().max(120).optional(),
        relationshipOther: z.string().trim().max(120).optional(),
        firstName: z.string().trim().max(120).optional(),
        middleName: z.string().trim().max(120).optional(),
        lastName: z.string().trim().max(120).optional(),
        dateOfBirth: z.string().trim().max(20).optional(),
        phone: z.string().trim().max(40).optional(),
        email: z.string().trim().max(200).optional(),
      })
      .strict()
      .optional(),
    subject: z.record(z.string(), z.string().max(500)).optional(),
    family: z.record(z.string(), z.string().max(500)).optional(),
    addresses: z
      .object({
        home: addressCorrection.optional(),
        shipping: addressCorrection.optional(),
        billing: addressCorrection.optional(),
      })
      .strict()
      .optional(),
    geo: z
      .object({
        county: z.string().trim().min(1).max(120),
        city: z.string().trim().min(1).max(120),
      })
      .strict()
      .optional(),
    reason: z.string().trim().max(200).optional(),
    reasonOther: z.string().trim().max(200).optional(),
    deliveryMethod: z.string().trim().max(80).optional(),
    destinationType: z.enum(["domestic", "international"]).optional(),
    /** Blank/absent = keep stored ciphertext. Never returned, never logged. */
    requestorSsn: z.string().trim().max(20).optional(),
    /** All-or-nothing re-entry. Blank/absent = keep stored ciphertext. */
    paymentCard: paymentCardCorrection.optional(),
    note: z.string().trim().min(1).max(2000).optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.applicant !== undefined ||
      v.subject !== undefined ||
      v.family !== undefined ||
      v.addresses !== undefined ||
      v.geo !== undefined ||
      v.reason !== undefined ||
      v.reasonOther !== undefined ||
      v.deliveryMethod !== undefined ||
      v.destinationType !== undefined ||
      (v.requestorSsn !== undefined && v.requestorSsn !== "") ||
      v.paymentCard !== undefined,
    { message: "Provide at least one field to correct." },
  );

/** Mongoose Maps come back as Map instances under lean() — normalize to objects. */
function mapToRecord(value: unknown): Record<string, string> {
  if (value instanceof Map) {
    const out: Record<string, string> = {};
    for (const [k, v] of value as Map<string, unknown>) out[k] = String(v ?? "");
    return out;
  }
  if (value && typeof value === "object") {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = String(v ?? "");
    return out;
  }
  return {};
}

staffRouter.patch("/orders/:id/correction", async (req, res, next) => {
  try {
    const id = z.string().min(1).parse(req.params.id);
    const input = correctionSchema.parse(req.body);
    const user = reqUser(req);
    if (!canCorrectOrders(user.role))
      throw new ApiError(403, "Only ADMIN or CS may edit order form data.");
    const order = await Order.findById(id).lean();
    if (!order) throw new ApiError(404, "Order not found");
    if (user.role === "CS" && (!order.assignedTo || String(order.assignedTo) !== user.sub))
      throw new ApiError(403, "Take ownership of this order before editing it.");
    if (order.status === "SUBMITTED" || order.status === "CANCELLED")
      throw new ApiError(409, "Closed orders are read-only.");
    if (
      order.certificate !== "BIRTH" &&
      order.certificate !== "DEATH" &&
      order.certificate !== "MARRIAGE" &&
      order.certificate !== "DIVORCE"
    )
      throw new ApiError(422, "Order has an unknown certificate type.");

    // Merge the patch over the stored order, then validate the whole form.
    const storedApplicant = (order.applicant ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));
    const mergedApplicant = {
      relationship: str(input.applicant?.relationship ?? storedApplicant.relationship),
      relationshipOther: str(
        input.applicant?.relationshipOther ?? storedApplicant.relationshipOther,
      ),
      firstName: str(input.applicant?.firstName ?? storedApplicant.firstName),
      middleName: str(input.applicant?.middleName ?? storedApplicant.middleName),
      lastName: str(input.applicant?.lastName ?? storedApplicant.lastName),
      dateOfBirth: str(input.applicant?.dateOfBirth ?? storedApplicant.dateOfBirth),
      phone: str(input.applicant?.phone ?? storedApplicant.phone),
      email: str(input.applicant?.email ?? storedApplicant.email),
    };
    const mergedSubject = { ...mapToRecord(order.subject), ...(input.subject ?? {}) };
    const mergedFamily = { ...mapToRecord(order.family), ...(input.family ?? {}) };
    const storedAddresses = (order.addresses ?? {}) as Record<string, Record<string, unknown>>;
    const addressBlock = (kind: string): Record<string, string> => {
      const stored = storedAddresses[kind] ?? {};
      const patch = input.addresses?.[kind as keyof typeof input.addresses] ?? {};
      const out: Record<string, string> = {};
      for (const key of [
        "firstName",
        "lastName",
        "line1",
        "line2",
        "city",
        "state",
        "postalCode",
        "country",
      ]) {
        out[key] = str(
          (patch as Record<string, unknown>)[key] ?? (stored as Record<string, unknown>)[key],
        );
      }
      return out;
    };
    const storedGeo = (order.geo ?? {}) as Record<string, unknown>;
    const candidate: CorrectionCandidate = {
      certificate: order.certificate,
      stateCode: order.stateCode,
      applicant: mergedApplicant,
      subject: mergedSubject,
      family: mergedFamily,
      addresses: {
        home: addressBlock("home"),
        shipping: addressBlock("shipping"),
        billing: addressBlock("billing"),
      },
      county: str(input.geo?.county ?? storedGeo.county),
      city: str(input.geo?.city ?? storedGeo.city),
      reason: str(input.reason ?? order.reason),
      reasonOther: str(input.reasonOther ?? order.reasonOther),
      deliveryMethod: str(input.deliveryMethod ?? order.deliveryMethod),
      destinationType:
        input.destinationType ??
        (order.destinationType === "international" ? "international" : "domestic"),
      requestorSsn: input.requestorSsn,
      paymentCard: input.paymentCard,
    };
    const check = validateCorrection(candidate);
    if (!check.ok)
      return res
        .status(422)
        .json({ message: "Please correct the highlighted fields.", errors: check.errors });

    const set: Record<string, unknown> = {};
    const fields: string[] = [];
    if (input.applicant) {
      for (const [k, v] of Object.entries(input.applicant)) {
        if (v !== undefined) {
          set[`applicant.${k}`] = v;
          fields.push(`applicant.${k}`);
        }
      }
    }
    if (input.subject !== undefined) {
      set.subject = input.subject;
      fields.push("subject");
    }
    if (input.family !== undefined) {
      set.family = input.family;
      fields.push("family");
    }
    if (input.addresses) {
      for (const [addr, patch] of Object.entries(input.addresses)) {
        if (!patch) continue;
        for (const [k, v] of Object.entries(patch)) {
          if (v !== undefined) {
            set[`addresses.${addr}.${k}`] = v;
            fields.push(`addresses.${addr}.${k}`);
          }
        }
      }
    }
    if (input.geo) {
      set["geo.county"] = input.geo.county;
      set["geo.city"] = input.geo.city;
      fields.push("geo.county", "geo.city");
    }
    if (input.reason !== undefined) {
      set.reason = input.reason;
      fields.push("reason");
    }
    if (input.reasonOther !== undefined) {
      set.reasonOther = input.reasonOther;
      fields.push("reasonOther");
    }
    if (input.deliveryMethod !== undefined) {
      set.deliveryMethod = input.deliveryMethod;
      fields.push("deliveryMethod");
    }
    if (input.destinationType !== undefined) {
      set.destinationType = input.destinationType;
      fields.push("destinationType");
    }
    // Secrets: encrypt + store, audit field names only — values never logged.
    if (input.requestorSsn !== undefined && input.requestorSsn !== "") {
      if (!isPlausibleSsn(input.requestorSsn.trim()))
        return res.status(422).json({
          message: "Please correct the highlighted fields.",
          errors: { requestorSsn: "Please enter a valid Social Security Number." },
        });
      set["confidentialData.ssnEnc"] = encryptSensitive(input.requestorSsn.trim());
      set["confidentialData.keyId"] = env.SENSITIVE_KEY_ID;
      set["confidentialData.encryptedAt"] = new Date();
      fields.push("requestorSsn");
    }
    if (input.paymentCard !== undefined) {
      set["confidentialData.cardNumberEnc"] = encryptSensitive(
        input.paymentCard.number.replace(/[\s-]/g, ""),
      );
      set["confidentialData.cardExpiryEnc"] = encryptSensitive(input.paymentCard.expiry.trim());
      set["confidentialData.cardCvcEnc"] = encryptSensitive(input.paymentCard.securityCode.trim());
      set["confidentialData.keyId"] = env.SENSITIVE_KEY_ID;
      set["confidentialData.encryptedAt"] = new Date();
      fields.push("paymentCard");
    }
    if (fields.length === 0) throw new ApiError(422, "Provide at least one field to correct.");
    const occurredAt = new Date();
    const push: Record<string, unknown> = {
      auditEvents: orderEvent(user.sub, "form_corrected", { fields }),
    };
    if (input.note) {
      (push as { notes: unknown }).notes = {
        authorId: user.sub,
        body: input.note,
        createdAt: occurredAt,
      };
    }
    await Order.updateOne({ _id: id }, { $set: set, $push: push });
    res.json({ ok: true, corrected: fields });
  } catch (e) {
    next(e);
  }
});
