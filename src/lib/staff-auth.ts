import { createHash, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import * as OTPAuth from "otpauth";
import { env } from "../config/env.js";
import { decryptSensitive, encryptSensitive } from "./crypto.js";

/** Invitation tokens live 48h. Login lockout: 5 failures -> 15min lock. */
export const INVITE_TTL_MS = 48 * 60 * 60 * 1000;
export const MAX_LOGIN_ATTEMPTS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;
/** Short-lived token that carries a user between password-check and TOTP. */
export const MFA_TOKEN_TTL = "10m";
const MFA_TOKEN_AUDIENCE = "usvc-staff-mfa";

export function newInviteToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  return { token, tokenHash };
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** TOTP secret is encrypted at rest with the sensitive-data KEK. */
export function encryptMfaSecret(base32Secret: string): string {
  return encryptSensitive(base32Secret);
}

export function decryptMfaSecret(stored: string): string {
  return decryptSensitive(stored);
}

export function newTotpSecret(): OTPAuth.Secret {
  return new OTPAuth.Secret({ size: 20 });
}

export function totpFor(secretBase32: string, email: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: "USVC Fulfillment",
    label: email,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
}

/** Accepts the current code plus one step of clock drift either way. */
export function verifyTotpCode(secretBase32: string, code: string): boolean {
  const digits = code.replace(/\D/g, "");
  if (digits.length !== 6) return false;
  try {
    const delta = totpFor(secretBase32, "usvc").validate({ token: digits, window: 1 });
    return delta !== null;
  } catch {
    return false;
  }
}

export function signMfaToken(userId: string): string {
  return jwt.sign({ sub: userId, purpose: "mfa" }, env.JWT_ACCESS_SECRET, {
    expiresIn: MFA_TOKEN_TTL,
    audience: MFA_TOKEN_AUDIENCE,
  });
}

export function verifyMfaToken(token: string): string {
  const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
    audience: MFA_TOKEN_AUDIENCE,
  }) as { sub?: string; purpose?: string };
  if (!payload?.sub || payload.purpose !== "mfa") throw new Error("Invalid MFA token");
  return payload.sub;
}

/** Access tokens carry an `iat` so MFA-reset/session-revoke can refuse old ones. */
export function signStaffTokens(user: {
  _id: { toHexString(): string };
  email: string;
  role: "ADMIN" | "STAFF";
}): { accessToken: string; refreshToken: string } {
  return {
    accessToken: jwt.sign(
      { sub: user._id.toHexString(), email: user.email, role: user.role },
      env.JWT_ACCESS_SECRET,
      { expiresIn: "30m" },
    ),
    refreshToken: jwt.sign(
      { sub: user._id.toHexString(), email: user.email, role: user.role },
      env.JWT_REFRESH_SECRET,
      { expiresIn: "7d" },
    ),
  };
}
