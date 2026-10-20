import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { ApiError } from "../middleware/errors.js";
import type { AuthUser } from "../middleware/auth.js";
import { StaffAccessAudit } from "../models/staff-access-audit.js";

export const dashboardUser = (req: Request) => (req as Request & { user: AuthUser }).user;
export function requireAdminOrCs(req: Request, _res: Response, next: NextFunction) {
  const role = dashboardUser(req)?.role;
  if (role !== "ADMIN" && role !== "CS")
    return next(new ApiError(403, "ADMIN or CS access required."));
  next();
}
export async function auditDashboard(req: Request, action: string, references: string[]) {
  // Deliberately no search terms, customer values, Stripe payloads or notes.
  await StaffAccessAudit.create({ actorId: dashboardUser(req).sub, action, references });
}
export const objectId = z.string().regex(/^[a-f\d]{24}$/i);
export const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "Invalid date");
export function dateBounds(from?: string, to?: string) {
  return {
    ...(from ? { $gte: new Date(`${from}T00:00:00Z`) } : {}),
    ...(to ? { $lt: new Date(new Date(`${to}T00:00:00Z`).getTime() + 86_400_000) } : {}),
  };
}
