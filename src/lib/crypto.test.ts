import { describe, test } from "node:test";
import assert from "node:assert/strict";

process.env.SENSITIVE_ENCRYPTION_KEY ??= "a".repeat(64);
process.env.SENSITIVE_KEY_ID ??= "v1";

const { encryptSensitive, decryptSensitive } = await import("./crypto.js");

describe("confidentialData crypto (AES-256-GCM)", () => {
  test("roundtrips SSN and card fields", () => {
    for (const value of ["123-45-6789", "4111111111111111", "12/30", "123"]) {
      const enc = encryptSensitive(value);
      assert.notEqual(enc, value);
      assert.ok(enc.startsWith("v1."));
      assert.equal(decryptSensitive(enc), value);
    }
  });

  test("empty stays empty (optional SSN on non-birth orders)", () => {
    assert.equal(encryptSensitive(""), "");
    assert.equal(decryptSensitive(""), "");
  });

  test("random IV: same input encrypts differently", () => {
    assert.notEqual(encryptSensitive("4111111111111111"), encryptSensitive("4111111111111111"));
  });

  test("tampered ciphertext is rejected", () => {
    const enc = encryptSensitive("123-45-6789");
    const parts = enc.split(".");
    parts[3] = Buffer.from("tampered-ciphertext-payload!!").toString("base64");
    assert.throws(() => decryptSensitive(parts.join(".")), /unsupported|auth|decrypt|error/i);
  });

  test("wrong version / key id is rejected", () => {
    const enc = encryptSensitive("123");
    assert.throws(() => decryptSensitive(enc.replace(/^v1\./, "v9.")), /unsupported/i);
    assert.throws(() => decryptSensitive("not-a-payload"), /unsupported/i);
  });
});
