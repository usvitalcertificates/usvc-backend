import assert from "node:assert/strict";
import test from "node:test";
import { envSchema } from "./env.js";

function baseEnv(overrides: Record<string, string> = {}) {
  return {
    MONGODB_URI: "mongodb://localhost:27017/test",
    FRONTEND_URL: "http://localhost:3000",
    JWT_ACCESS_SECRET: "a".repeat(32),
    JWT_REFRESH_SECRET: "b".repeat(32),
    STRIPE_SECRET_KEY: "sk_test_123",
    STRIPE_WEBHOOK_SECRET: "whsec_123",
    STRIPE_PUBLISHABLE_KEY: "pk_test_123",
    SENSITIVE_ENCRYPTION_KEY: "c".repeat(64),
    ...overrides,
  };
}

test("defaults to the test payment environment with test keys", () => {
  const parsed = envSchema.safeParse(baseEnv());
  assert.equal(parsed.success, true);
});

test("live environment requires live keys", () => {
  const parsed = envSchema.safeParse(baseEnv({ PAYMENT_ENVIRONMENT: "live" }));
  assert.equal(parsed.success, false);
});

test("live environment accepts live keys", () => {
  const parsed = envSchema.safeParse(
    baseEnv({
      PAYMENT_ENVIRONMENT: "live",
      STRIPE_SECRET_KEY: "sk_live_123",
      STRIPE_PUBLISHABLE_KEY: "pk_live_123",
    }),
  );
  assert.equal(parsed.success, true);
});

test("live keys are rejected outside the live environment", () => {
  const parsed = envSchema.safeParse({
    ...baseEnv(),
    STRIPE_SECRET_KEY: "sk_live_123",
    STRIPE_PUBLISHABLE_KEY: "pk_live_123",
  });
  assert.equal(parsed.success, false);
});

test("enabled Zoho email needs only API and signed-webhook credentials", () => {
  const enabled = baseEnv({
    EMAIL_ENABLED: "true",
    EMAIL_FROM: "USVC <noreply@example.test>",
    EMAIL_REPLY_TO: "support@example.test",
    STAFF_PORTAL_URL: "https://example.test",
    ZOHO_EMAIL_API_KEY: "send-key",
    ZOHO_WEBHOOK_SECRET: "s".repeat(32),
  });
  assert.equal(envSchema.safeParse(enabled).success, true);
  assert.equal(envSchema.safeParse({ ...enabled, ZOHO_WEBHOOK_SECRET: undefined }).success, false);
  assert.equal(
    "SMTP_PASSWORD" in envSchema.parse({ ...enabled, SMTP_PASSWORD: "obsolete" }),
    false,
  );
  for (const key of ["ZOHO_EMAIL_API_KEY", "ZOHO_WEBHOOK_SECRET"]) {
    const missing = { ...enabled };
    delete missing[key as keyof typeof missing];
    assert.equal(envSchema.safeParse(missing).success, false, key);
  }
  assert.equal(
    envSchema.safeParse({ ...enabled, ZOHO_EMAIL_API_KEY: "Zoho-enczapikey prefixed-token" })
      .success,
    false,
  );
  assert.equal(
    envSchema.safeParse({ ...enabled, EMAIL_FROM: "invalid\r\nBcc: someone@example.test" }).success,
    false,
  );
});
