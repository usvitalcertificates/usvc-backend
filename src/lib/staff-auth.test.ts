import assert from "node:assert/strict";
import test from "node:test";

process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017/usvc-test";
process.env.FRONTEND_URL ??= "http://localhost:3000";
process.env.JWT_ACCESS_SECRET ??= "a".repeat(32);
process.env.JWT_REFRESH_SECRET ??= "b".repeat(32);
process.env.STRIPE_SECRET_KEY ??= "sk_test_dummy";
process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_dummy";
process.env.STRIPE_PUBLISHABLE_KEY ??= "pk_test_dummy";
process.env.SENSITIVE_ENCRYPTION_KEY ??= "a".repeat(64);
process.env.SENSITIVE_KEY_ID ??= "v1";

const {
  hashInviteToken,
  newInviteToken,
  newTotpSecret,
  signMfaToken,
  totpFor,
  verifyMfaToken,
  verifyTotpCode,
} = await import("./staff-auth.js");

test("invite tokens hash consistently and are unique per invite", () => {
  const first = newInviteToken();
  const second = newInviteToken();
  assert.notEqual(first.token, second.token);
  assert.equal(hashInviteToken(first.token), first.tokenHash);
  assert.equal(first.tokenHash.length, 64);
});

test("a generated TOTP code verifies, a wrong code does not", () => {
  const secret = newTotpSecret().base32;
  const code = totpFor(secret, "agent@example.com").generate();
  assert.equal(verifyTotpCode(secret, code), true);
  assert.equal(verifyTotpCode(secret, "000000"), code === "000000");
  assert.equal(verifyTotpCode(secret, "abc"), false);
});

test("MFA tokens round-trip the staff id and reject tampering", () => {
  const userId = "66f123456789abcdef012345";
  const token = signMfaToken(userId);
  assert.equal(verifyMfaToken(token), userId);
  assert.throws(() => verifyMfaToken(`${token}x`));
});
