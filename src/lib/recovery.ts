import { createHmac, randomBytes } from "node:crypto";
import { env } from "../config/env.js";
import { encryptSensitive } from "./crypto.js";
import { ApiError } from "../middleware/errors.js";
import { RecoveryGrant, RecoveryLimit } from "../models/recovery.js";
import { EmailOutbox } from "../models/email-outbox.js";
import type { ClientSession } from "mongoose";
export const RECOVERY_MESSAGE =
  "If a saved application matches this email, we’ll send recovery instructions.";
export const recoveryHash = (value: string) =>
  createHmac("sha256", env.JWT_REFRESH_SECRET).update(value).digest("hex");
export const recoveryToken = () => randomBytes(32).toString("base64url");
export function requireRecoveryEmail() {
  if (!env.EMAIL_ENABLED)
    throw new ApiError(
      503,
      "Application recovery is temporarily unavailable. Please contact support.",
    );
}
export async function recoveryLimit(key: string, max: number, windowMs: number) {
  const bucket = Math.floor(Date.now() / windowMs);
  const _id = recoveryHash(`${key}:${bucket}`);
  let row;
  try {
    row = await RecoveryLimit.findOneAndUpdate(
      { _id },
      { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((bucket + 2) * windowMs) } },
      { upsert: true, returnDocument: "after" },
    );
  } catch (e) {
    if ((e as { code?: number }).code !== 11000) throw e;
    row = await RecoveryLimit.findOneAndUpdate(
      { _id },
      { $inc: { count: 1 } },
      { returnDocument: "after" },
    );
  }
  if (!row || row.count > max)
    throw new ApiError(429, "Too many attempts. Please try again later.");
}
export async function newRecoveryGrant(
  email: string,
  source: "SELF" | "STAFF",
  orderId?: unknown,
  session?: ClientSession,
) {
  const token = recoveryToken(),
    expiresAt = new Date(Date.now() + 7 * 86400000);
  const [grant] = await RecoveryGrant.create(
    [
      {
        email: email.trim().toLowerCase(),
        source,
        orderId,
        tokenHash: recoveryHash(token),
        expiresAt,
      },
    ],
    { session },
  );
  return { grant, token, expiresAt, url: `${env.FRONTEND_URL.replace(/\/$/, "")}/resume#${token}` };
}
export async function queueRecoveryEmail(
  recipient: string,
  template: "RECOVERY_LINK" | "RECOVERY_CODE",
  secret: string,
  expiresAt: Date,
  grantId: unknown,
  challengeId?: unknown,
  session?: ClientSession,
) {
  await EmailOutbox.create(
    [
      {
        _id: `recovery_${recoveryToken()}`,
        recipient,
        template,
        recoverySecret: encryptSensitive(secret),
        recoveryExpiresAt: expiresAt,
        recoveryGrantId: grantId,
        recoveryChallengeId: challengeId,
      },
    ],
    { session },
  );
}
