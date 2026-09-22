import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../config/env.js";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const VERSION = "v1";

/** Decode SENSITIVE_ENCRYPTION_KEY (64-char hex or base64) to 32 bytes. Throws on misconfig. */
export function sensitiveKeyBytes(): Buffer {
  const raw = env.SENSITIVE_ENCRYPTION_KEY.trim();
  let bytes: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) bytes = Buffer.from(raw, "hex");
  else bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 32)
    throw new Error("SENSITIVE_ENCRYPTION_KEY must decode to 32 bytes (64-char hex or base64).");
  return bytes;
}

/** Encrypt a UTF-8 string. Empty input stays empty (nothing to protect). */
export function encryptSensitive(plaintext: string): string {
  if (!plaintext) return "";
  const key = sensitiveKeyBytes();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    env.SENSITIVE_KEY_ID,
    iv.toString("base64"),
    ciphertext.toString("base64"),
    tag.toString("base64"),
  ].join(".");
}

/** Decrypt a payload produced by encryptSensitive. Empty stays empty. Throws on tamper/version/key mismatch. */
export function decryptSensitive(payload: string): string {
  if (!payload) return "";
  const parts = payload.split(".");
  if (parts.length !== 5 || parts[0] !== VERSION)
    throw new Error("Unsupported encrypted payload format.");
  const [, keyId, ivB64, ctB64, tagB64] = parts;
  if (keyId !== env.SENSITIVE_KEY_ID) throw new Error("Unsupported encryption key id.");
  const key = sensitiveKeyBytes();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return decipher.update(Buffer.from(ctB64, "base64"), undefined, "utf8") + decipher.final("utf8");
}
