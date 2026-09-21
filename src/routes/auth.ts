import { Router } from "express";
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../config/env.js";
import { StaffUser } from "../models/staff.js";
import { ApiError } from "../middleware/errors.js";
const credentials = z.object({ email: z.string().email(), password: z.string().min(12) });
const sign = (user: {
  _id: { toHexString(): string };
  email: string;
  role: "ADMIN" | "STAFF";
}) => ({
  accessToken: jwt.sign(
    { sub: user._id.toHexString(), email: user.email, role: user.role },
    env.JWT_ACCESS_SECRET,
    { expiresIn: "15m" },
  ),
  refreshToken: jwt.sign(
    { sub: user._id.toHexString(), email: user.email, role: user.role },
    env.JWT_REFRESH_SECRET,
    { expiresIn: "7d" },
  ),
});
export const authRouter = Router();
authRouter.post("/login", async (req, res, next) => {
  try {
    const { email, password } = credentials.parse(req.body);
    const user = await StaffUser.findOne({ email });
    if (!user || !(await argon2.verify(user.passwordHash, password)))
      throw new ApiError(401, "Invalid credentials");
    const tokens = sign(user);
    user.refreshTokenHash = await argon2.hash(tokens.refreshToken);
    await user.save();
    res.json({ ...tokens, mfaRequired: user.mfaEnabled });
  } catch (e) {
    next(e);
  }
});
