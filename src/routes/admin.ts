import { Router } from "express";
import { z } from "zod";
import {
  requireActiveStaff,
  requireAdmin,
  requireAuth,
  type AuthUser,
} from "../middleware/auth.js";
import { ApiError } from "../middleware/errors.js";
import { Order } from "../models/order.js";
import { StaffUser } from "../models/staff.js";

export const adminRouter = Router();
adminRouter.use(requireAuth, requireActiveStaff, requireAdmin);

const staffEvent = (actorId: string, action: string, metadata?: Record<string, unknown>) => ({
  actorId,
  action,
  metadata,
  createdAt: new Date(),
});

/** Staff roster for the super-admin dashboard. Secrets are never selected. */
adminRouter.get("/staff", async (_req, res, next) => {
  try {
    const staff: StaffRosterEntry[] = await StaffUser.find(
      {},
      {
        fullName: 1,
        email: 1,
        role: 1,
        accountStatus: 1,
        mfaEnabled: 1,
        lastLoginAt: 1,
        lastActivityAt: 1,
      },
    )
      .sort({ createdAt: 1 })
      .lean();
    const assigned: { _id: unknown; active: number }[] = await Order.aggregate([
      { $match: { assignedTo: { $ne: null }, status: { $ne: "SUBMITTED" } } },
      { $group: { _id: "$assignedTo", active: { $sum: 1 } } },
    ]);
    const activeById = new Map(
      assigned.map((row: { _id: unknown; active: number }) => [String(row._id), row.active]),
    );
    res.json({
      staff: staff.map(
        (
          member: StaffRosterEntry & {
            role?: string;
            accountStatus?: string;
            mfaEnabled?: boolean;
            lastLoginAt?: Date | null;
            lastActivityAt?: Date | null;
          },
        ) => ({
          id: String(member._id),
          fullName: member.fullName || "",
          email: member.email,
          role: member.role,
          accountStatus: member.accountStatus,
          mfaEnabled: member.mfaEnabled,
          lastLoginAt: member.lastLoginAt ?? null,
          lastActivityAt: member.lastActivityAt ?? null,
          activeOrders: activeById.get(String(member._id)) ?? 0,
        }),
      ),
    });
  } catch (e) {
    next(e);
  }
});

adminRouter.patch("/staff/:id", async (req, res, next) => {
  try {
    const id = z.string().min(1).parse(req.params.id);
    const input = z
      .object({
        fullName: z.string().trim().min(1).max(120).optional(),
        accountStatus: z.enum(["active", "disabled"]).optional(),
      })
      .parse(req.body);
    const admin = (req as typeof req & { user: AuthUser }).user;
    if (id === admin.sub) throw new ApiError(400, "You cannot change your own account here.");
    const member = await StaffUser.findById(id);
    if (!member) throw new ApiError(404, "Staff account not found");
    if (input.fullName !== undefined) member.fullName = input.fullName;
    if (input.accountStatus !== undefined) {
      member.accountStatus = input.accountStatus;
      if (input.accountStatus === "disabled") {
        member.sessionsRevokedAt = new Date();
        member.refreshTokenHash = undefined;
      }
    }
    member.auditEvents ??= [];
    member.auditEvents.push(staffEvent(admin.sub, "staff_updated", { ...input }));
    await member.save();
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/** Immediately refuses every session issued before now. */
adminRouter.post("/staff/:id/revoke", async (req, res, next) => {
  try {
    const id = z.string().min(1).parse(req.params.id);
    const admin = (req as typeof req & { user: AuthUser }).user;
    const member = await StaffUser.findById(id).select("+refreshTokenHash");
    if (!member) throw new ApiError(404, "Staff account not found");
    member.sessionsRevokedAt = new Date();
    member.refreshTokenHash = undefined;
    member.auditEvents ??= [];
    member.auditEvents.push(staffEvent(admin.sub, "sessions_revoked"));
    await member.save();
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/**
 * Lost-authenticator recovery. Clears the pairing, forces re-enrollment, and
 * revokes all sessions. The secret itself is never readable by the admin.
 */
adminRouter.post("/staff/:id/mfa-reset", async (req, res, next) => {
  try {
    const id = z.string().min(1).parse(req.params.id);
    const admin = (req as typeof req & { user: AuthUser }).user;
    const member = await StaffUser.findById(id).select("+mfaSecret +refreshTokenHash");
    if (!member) throw new ApiError(404, "Staff account not found");
    member.mfaEnabled = false;
    member.mfaSecret = undefined;
    member.mfaEnrolledAt = undefined;
    member.sessionsRevokedAt = new Date();
    member.refreshTokenHash = undefined;
    member.failedLoginAttempts = 0;
    member.lockedUntil = undefined;
    member.auditEvents ??= [];
    member.auditEvents.push(staffEvent(admin.sub, "mfa_reset"));
    await member.save();
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

interface WorkloadRow {
  _id: unknown;
  active: number;
  completed: number;
}

interface StaffRosterEntry {
  _id: unknown;
  fullName?: string;
  email: string;
}

interface AuditEventLean {
  actorId?: string;
  action?: string;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

interface MemberWithAudit extends StaffRosterEntry {
  auditEvents?: AuditEventLean[];
}

interface OrderWithAudit {
  publicNumber: string;
  auditEvents?: AuditEventLean[];
}
/** Per-agent workload: active vs completed orders. */
adminRouter.get("/workload", async (_req, res, next) => {
  try {
    const rows: WorkloadRow[] = await Order.aggregate([
      { $match: { assignedTo: { $ne: null } } },
      {
        $group: {
          _id: "$assignedTo",
          active: { $sum: { $cond: [{ $ne: ["$status", "SUBMITTED"] }, 1, 0] } },
          completed: { $sum: { $cond: [{ $eq: ["$status", "SUBMITTED"] }, 1, 0] } },
        },
      },
    ]);
    const staff: StaffRosterEntry[] = await StaffUser.find({}, { fullName: 1, email: 1 }).lean();
    const names = new Map(staff.map((member: StaffRosterEntry) => [String(member._id), member]));
    res.json({
      workload: rows.map((row: WorkloadRow) => ({
        staffId: String(row._id),
        fullName: names.get(String(row._id))?.fullName || "",
        email: names.get(String(row._id))?.email || "",
        active: row.active,
        completed: row.completed,
      })),
    });
  } catch (e) {
    next(e);
  }
});

/** Combined staff + order activity feed. Events never contain secrets. */
adminRouter.get("/activity", async (req, res, next) => {
  try {
    const { staffId, action, limit } = z
      .object({
        staffId: z.string().optional(),
        action: z.string().max(60).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(req.query);
    const staffFilter = staffId ? { _id: staffId } : {};
    const members: MemberWithAudit[] = await StaffUser.find(staffFilter, {
      fullName: 1,
      email: 1,
      auditEvents: 1,
    }).lean();
    const idToEmail = new Map(
      members.map((member: MemberWithAudit) => [String(member._id), member.email]),
    );
    const entries: {
      at: Date;
      actorEmail: string;
      action: string;
      orderNumber?: string;
      detail?: Record<string, unknown>;
    }[] = [];
    for (const member of members) {
      for (const event of member.auditEvents ?? []) {
        if (action && event.action !== action) continue;
        entries.push({
          at: event.createdAt ?? new Date(),
          actorEmail: member.email,
          action: event.action ?? "",
          detail: (event.metadata ?? undefined) as Record<string, unknown> | undefined,
        });
      }
    }
    const orderMatch: Record<string, unknown> = {};
    if (staffId) orderMatch["auditEvents.actorId"] = staffId;
    if (action) orderMatch["auditEvents.action"] = action;
    const orders: OrderWithAudit[] = await Order.find(orderMatch, {
      publicNumber: 1,
      auditEvents: 1,
    })
      .sort({ updatedAt: -1 })
      .limit(200)
      .lean();
    for (const order of orders) {
      for (const event of order.auditEvents ?? []) {
        if (staffId && event.actorId !== staffId) continue;
        if (action && event.action !== action) continue;
        entries.push({
          at: event.createdAt ?? new Date(),
          actorEmail: event.actorId ? (idToEmail.get(event.actorId) ?? "Staff") : "System",
          action: event.action ?? "",
          orderNumber: order.publicNumber,
          detail: (event.metadata ?? undefined) as Record<string, unknown> | undefined,
        });
      }
    }
    entries.sort((a, b) => b.at.getTime() - a.at.getTime());
    res.json({ activity: entries.slice(0, limit) });
  } catch (e) {
    next(e);
  }
});
