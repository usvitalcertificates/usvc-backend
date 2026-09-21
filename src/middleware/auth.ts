import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { ApiError } from "./errors.js";
export type AuthUser = { sub: string; email: string; role: "ADMIN" | "STAFF" };
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
