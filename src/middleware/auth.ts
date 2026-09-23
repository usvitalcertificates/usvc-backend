import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { StaffUser } from "../models/staff.js";
import { ApiError } from "./errors.js";
export type AuthUser = { sub: string; email: string; role: "ADMIN" | "STAFF"; iat?: number };
export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.header("authorization")?.replace(/^Bearer /, "");
    if (!token) throw new Error();
    (req as Request & { user: AuthUser }).user = jwt.verify(
      token,
      env.JWT_ACCESS_SECRET,
    ) as AuthUser;
    next();
  } catch {
    next(new ApiError(401, "Authentication required"));
  }
};

/** Super-admin only. Must run after requireAuth. */
export const requireAdmin = (req: Request, _res: Response, next: NextFunction) => {
  const user = (req as Request & { user?: AuthUser }).user;
  if (!user) return next(new ApiError(401, "Authentication required"));
  if (user.role !== "ADMIN") return next(new ApiError(403, "Super-admin access required"));
  next();
};

/**
 * Active-staff gate for fulfillment routes. Refuses disabled/blocked accounts
 * and any token issued before a session revocation (MFA reset / revoke).
 * Updates lastActivityAt for workload tracking. Must run after requireAuth.
 */
export const requireActiveStaff = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const user = (req as Request & { user?: AuthUser }).user;
    if (!user) throw new ApiError(401, "Authentication required");
    const staff = await StaffUser.findById(user.sub, {
      accountStatus: 1,
      sessionsRevokedAt: 1,
    });
    if (!staff || staff.accountStatus !== "active")
      throw new ApiError(403, "This staff account is no longer active.");
    if (staff.sessionsRevokedAt && user.iat && user.iat * 1000 <= staff.sessionsRevokedAt.getTime())
      throw new ApiError(401, "Session revoked. Please sign in again.");
    await StaffUser.updateOne({ _id: staff._id }, { $set: { lastActivityAt: new Date() } });
    next();
  } catch (e) {
    next(e);
  }
};
