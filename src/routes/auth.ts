import { Router } from "express";
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import { toDataURL } from "qrcode";
import { z } from "zod";
import { env } from "../config/env.js";
import {
  requireActiveStaff,
  requireAdmin,
  requireAuth,
  type AuthUser,
} from "../middleware/auth.js";
import { ApiError } from "../middleware/errors.js";
import { EmailOutbox } from "../models/email-outbox.js";
import { StaffUser } from "../models/staff.js";
import {
  decryptMfaSecret,
  encryptMfaSecret,
  hashInviteToken,
  INVITE_TTL_MS,
  LOCKOUT_MS,
  MAX_LOGIN_ATTEMPTS,
  newInviteToken,
  newTotpSecret,
  signMfaToken,
  signStaffTokens,
  totpFor,
  verifyMfaToken,
  verifyTotpCode,
} from "../lib/staff-auth.js";

const credentials = z.object({ email: z.string().email(), password: z.string().min(8) });
const mfaCode = z.object({ mfaToken: z.string().min(1), code: z.string().min(6).max(12) });

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many sign-in attempts. Please try again later." },
});

const staffEvent = (actorId: string, action: string, metadata?: Record<string, unknown>) => ({
  actorId,
  action,
  metadata,
  createdAt: new Date(),
});

export const authRouter = Router();

/**
 * Step 1 — password check. Never returns tokens: the caller gets a 10-minute
 * MFA token and must complete step 2 (TOTP) before any order access.
 */
authRouter.post("/login", authLimiter, async (req, res, next) => {
  try {
    const { email, password } = credentials.parse(req.body);
    const user = await StaffUser.findOne({ email }).select(
      "+passwordHash +mfaSecret +refreshTokenHash",
    );
    const locked = user?.lockedUntil && user.lockedUntil.getTime() > Date.now();
    const ok = !locked && !!user && (await argon2.verify(user.passwordHash, password));
    if (!ok) {
      if (user && !locked) {
        const attempts = (user.failedLoginAttempts ?? 0) + 1;
        user.failedLoginAttempts = attempts;
        if (attempts >= MAX_LOGIN_ATTEMPTS) user.lockedUntil = new Date(Date.now() + LOCKOUT_MS);
        user.auditEvents ??= [];
        user.auditEvents.push(staffEvent(user._id.toHexString(), "login_failure"));
        await user.save();
      }
      throw new ApiError(401, "Invalid credentials");
    }
    if (user.accountStatus === "pending")
      throw new ApiError(403, "This invitation has not been set up yet. Use your setup link.");
    if (user.accountStatus !== "active")
      throw new ApiError(403, "This staff account is not active.");
    user.failedLoginAttempts = 0;
    user.lockedUntil = undefined;
    await user.save();
    res.json({
      mfaRequired: true,
      enroll: !user.mfaEnabled,
      mfaToken: signMfaToken(user._id.toHexString()),
    });
  } catch (e) {
    next(e);
  }
});

/** Step 2a — first-time pairing. Returns the QR + manual key exactly once. */
authRouter.post("/mfa/enroll", authLimiter, async (req, res, next) => {
  try {
    const { mfaToken } = z.object({ mfaToken: z.string().min(1) }).parse(req.body);
    const userId = verifyMfaToken(mfaToken);
    const user = await StaffUser.findById(userId).select("+mfaSecret");
    if (!user || user.accountStatus !== "active")
      throw new ApiError(403, "This staff account is not active.");
    if (user.mfaEnabled) throw new ApiError(409, "Authenticator is already enrolled.");
    const secret = newTotpSecret().base32;
    user.mfaSecret = encryptMfaSecret(secret);
    await user.save();
    const otpauthUrl = totpFor(secret, user.email).toString();
    res.json({ secret, otpauthUrl, qrDataUrl: await toDataURL(otpauthUrl) });
  } catch (e) {
    next(e);
  }
});

/** Step 2b — confirm pairing with a 6-digit code from the staff member's app. */
authRouter.post("/mfa/confirm", authLimiter, async (req, res, next) => {
  try {
    const { mfaToken, code } = mfaCode.parse(req.body);
    const userId = verifyMfaToken(mfaToken);
    const user = await StaffUser.findById(userId).select("+mfaSecret +refreshTokenHash");
    if (!user || user.accountStatus !== "active" || !user.mfaSecret)
      throw new ApiError(403, "Enrollment has not been started.");
    if (!verifyTotpCode(decryptMfaSecret(user.mfaSecret), code)) {
      user.auditEvents ??= [];
      user.auditEvents.push(staffEvent(userId, "mfa_failure", { stage: "enrollment" }));
      await user.save();
      throw new ApiError(401, "That code was not accepted. Try the current 6-digit code.");
    }
    user.mfaEnabled = true;
    user.mfaEnrolledAt = new Date();
    user.mfaLastVerifiedAt = new Date();
    user.lastLoginAt = new Date();
    const tokens = signStaffTokens(user);
    user.refreshTokenHash = await argon2.hash(tokens.refreshToken);
    user.auditEvents ??= [];
    user.auditEvents.push(staffEvent(userId, "mfa_enrolled"));
    user.auditEvents.push(staffEvent(userId, "login_success"));
    await user.save();
    res.json({ ...tokens, role: user.role });
  } catch (e) {
    next(e);
  }
});

/** Step 2c — daily verification for already-enrolled staff. */
authRouter.post("/mfa/verify", authLimiter, async (req, res, next) => {
  try {
    const { mfaToken, code } = mfaCode.parse(req.body);
    const userId = verifyMfaToken(mfaToken);
    const user = await StaffUser.findById(userId).select("+mfaSecret +refreshTokenHash");
    if (!user || user.accountStatus !== "active")
      throw new ApiError(403, "This staff account is not active.");
    if (!user.mfaEnabled || !user.mfaSecret)
      throw new ApiError(409, "Authenticator enrollment is required first.");
    if (!verifyTotpCode(decryptMfaSecret(user.mfaSecret), code)) {
      user.auditEvents ??= [];
      user.auditEvents.push(staffEvent(userId, "mfa_failure", { stage: "verification" }));
      await user.save();
      throw new ApiError(401, "That code was not accepted. Try the current 6-digit code.");
    }
    user.mfaLastVerifiedAt = new Date();
    user.lastLoginAt = new Date();
    const tokens = signStaffTokens(user);
    user.refreshTokenHash = await argon2.hash(tokens.refreshToken);
    user.auditEvents ??= [];
    user.auditEvents.push(staffEvent(userId, "login_success"));
    await user.save();
    res.json({ ...tokens, role: user.role });
  } catch (e) {
    next(e);
  }
});

authRouter.post("/refresh", async (req, res, next) => {
  try {
    const { refreshToken } = z.object({ refreshToken: z.string().min(1) }).parse(req.body);
    let payload: AuthUser;
    try {
      payload = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET) as AuthUser;
    } catch {
      throw new ApiError(401, "Session expired. Please sign in again.");
    }
    const user = await StaffUser.findById(payload.sub).select("+refreshTokenHash");
    if (
      !user ||
      user.accountStatus !== "active" ||
      !user.refreshTokenHash ||
      !(await argon2.verify(user.refreshTokenHash, refreshToken))
    )
      throw new ApiError(401, "Session expired. Please sign in again.");
    if (
      user.sessionsRevokedAt &&
      payload.iat &&
      payload.iat * 1000 <= user.sessionsRevokedAt.getTime()
    )
      throw new ApiError(401, "Session revoked. Please sign in again.");
    const tokens = signStaffTokens(user);
    user.refreshTokenHash = await argon2.hash(tokens.refreshToken);
    await user.save();
    res.json(tokens);
  } catch (e) {
    next(e);
  }
});

authRouter.post("/logout", async (req, res, next) => {
  try {
    const { refreshToken } = z.object({ refreshToken: z.string().min(1) }).parse(req.body);
    try {
      const payload = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET) as AuthUser;
      const user = await StaffUser.findById(payload.sub).select("+refreshTokenHash");
      if (
        user &&
        user.refreshTokenHash &&
        (await argon2.verify(user.refreshTokenHash, refreshToken))
      ) {
        user.refreshTokenHash = undefined;
        await user.save();
      }
    } catch {
      /* Logout is idempotent — an expired token is already logged out. */
    }
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/** Super-admin invites a staff member. They set their own password via setup. */
authRouter.post(
  "/invite",
  requireAuth,
  requireActiveStaff,
  requireAdmin,
  async (req, res, next) => {
    try {
      const input = z
        .object({
          fullName: z.string().trim().min(1).max(120),
          email: z.string().email(),
          role: z.enum(["ADMIN", "FULFILLMENT", "CS"]).default("FULFILLMENT"),
        })
        .parse(req.body);
      const admin = (req as typeof req & { user: AuthUser }).user;
      if (await StaffUser.findOne({ email: input.email }))
        throw new ApiError(409, "A staff account already exists for this email.");
      const { token, tokenHash } = newInviteToken();
      const user = await StaffUser.create({
        email: input.email,
        fullName: input.fullName,
        // Placeholder — replaced at setup. Argon2 of a random value so it never validates.
        passwordHash: await argon2.hash(newInviteToken().token),
        role: input.role,
        accountStatus: "pending",
        inviteTokenHash: tokenHash,
        inviteExpiresAt: new Date(Date.now() + INVITE_TTL_MS),
        auditEvents: [
          staffEvent(admin.sub, "staff_invited", { email: input.email, role: input.role }),
        ],
      });
      // Email-enabled environments send the setup link via the durable outbox
      // and never return the token. Local/dev keeps the token response so the
      // invite flow is testable without email.
      if (env.EMAIL_ENABLED) {
        await EmailOutbox.create({
          _id: `staff-invitation:${user._id.toHexString()}`,
          staffUserId: user._id,
          setupToken: token,
          recipient: input.email,
          template: "STAFF_INVITATION",
        });
        user.auditEvents ??= [];
        user.auditEvents.push(staffEvent(admin.sub, "invitation_emailed", { email: input.email }));
        await user.save();
        return res.status(201).json({ id: user._id.toHexString(), emailed: true });
      }
      res.status(201).json({
        id: user._id.toHexString(),
        setupToken: token,
      });
    } catch (e) {
      next(e);
    }
  },
);

/**
 * Re-send an invitation (lost email or expired link). Regenerates the token,
 * drops any still-pending email for the account, and queues a fresh one.
 */
authRouter.post(
  "/invite/:id/resend",
  requireAuth,
  requireActiveStaff,
  requireAdmin,
  async (req, res, next) => {
    try {
      const id = z.string().min(1).parse(req.params.id);
      const admin = (req as typeof req & { user: AuthUser }).user;
      const user = await StaffUser.findById(id).select("+inviteTokenHash");
      if (!user || user.accountStatus !== "pending")
        throw new ApiError(404, "No pending invitation for this account.");
      const { token, tokenHash } = newInviteToken();
      user.inviteTokenHash = tokenHash;
      user.inviteExpiresAt = new Date(Date.now() + INVITE_TTL_MS);
      user.auditEvents ??= [];
      user.auditEvents.push(staffEvent(admin.sub, "invitation_re-sent", { email: user.email }));
      await user.save();
      await EmailOutbox.deleteMany({ staffUserId: user._id, status: "PENDING" });
      if (env.EMAIL_ENABLED) {
        await EmailOutbox.create({
          _id: `staff-invitation:${user._id.toHexString()}:${Date.now()}`,
          staffUserId: user._id,
          setupToken: token,
          recipient: user.email,
          template: "STAFF_INVITATION",
        });
        return res.json({ ok: true, emailed: true });
      }
      res.json({ ok: true, setupToken: token });
    } catch (e) {
      next(e);
    }
  },
);

/** Invited member sets their own password. Credentials are never shared.
 *  Also completes admin-issued password resets for active accounts. */
authRouter.post("/setup", authLimiter, async (req, res, next) => {
  try {
    const { token, password } = z
      .object({ token: z.string().min(1), password: z.string().min(8).max(200) })
      .parse(req.body);
    const user = await StaffUser.findOne({ inviteTokenHash: hashInviteToken(token) }).select(
      "+inviteTokenHash",
    );
    if (
      !user ||
      (user.accountStatus !== "pending" && user.accountStatus !== "active") ||
      !user.inviteExpiresAt ||
      user.inviteExpiresAt.getTime() < Date.now()
    )
      throw new ApiError(400, "This invitation link is invalid or has expired.");
    const isReset = user.accountStatus === "active";
    user.passwordHash = await argon2.hash(password);
    user.inviteTokenHash = undefined;
    user.inviteExpiresAt = undefined;
    if (!isReset) user.accountStatus = "active";
    if (isReset) {
      // A reset secret must kill every session issued under the old password.
      user.sessionsRevokedAt = new Date();
      user.refreshTokenHash = undefined;
      user.failedLoginAttempts = 0;
      user.lockedUntil = undefined;
    }
    user.auditEvents ??= [];
    user.auditEvents.push(
      staffEvent(
        user._id.toHexString(),
        isReset ? "password_reset_completed" : "invitation_accepted",
      ),
    );
    await user.save();
    res.json({ ok: true, mfaToken: signMfaToken(user._id.toHexString()) });
  } catch (e) {
    next(e);
  }
});

/**
 * Signed-in ADMIN changes their own password. Verifies the current password,
 * revokes every session including this one (sign in again), and audits.
 * Other roles have no self-service path by design.
 */
authRouter.post(
  "/password",
  authLimiter,
  requireAuth,
  requireActiveStaff,
  requireAdmin,
  async (req, res, next) => {
    try {
      const { currentPassword, newPassword } = z
        .object({
          currentPassword: z.string().min(1).max(200),
          newPassword: z.string().min(8).max(200),
        })
        .parse(req.body);
      if (currentPassword === newPassword)
        throw new ApiError(422, "The new password must be different.");
      const actor = (req as typeof req & { user: AuthUser }).user;
      const user = await StaffUser.findById(actor.sub).select("+passwordHash");
      if (!user) throw new ApiError(404, "Staff account not found");
      if (!(await argon2.verify(user.passwordHash, currentPassword)))
        throw new ApiError(403, "The current password is incorrect.");
      user.passwordHash = await argon2.hash(newPassword);
      user.sessionsRevokedAt = new Date();
      user.refreshTokenHash = undefined;
      user.failedLoginAttempts = 0;
      user.lockedUntil = undefined;
      user.auditEvents ??= [];
      user.auditEvents.push(staffEvent(actor.sub, "password_changed"));
      await user.save();
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  },
);
