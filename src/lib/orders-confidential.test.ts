import { describe, test } from "node:test";
import assert from "node:assert/strict";

process.env.SENSITIVE_ENCRYPTION_KEY ??= "a".repeat(64);
process.env.SENSITIVE_KEY_ID ??= "v1";

const { encryptSensitive, decryptSensitive } = await import("./crypto.js");
const { Order } = await import("../models/order.js");

function baseOrder() {
  return {
    publicNumber: "USVC-BI-TEST-CIPHERTEXT",
    stateSlug: "alabama",
    stateName: "Alabama",
    stateCode: "AL",
    certificate: "BIRTH",
    geo: { county: "Autauga", city: "Autaugaville" },
    reason: "Personal records",
    applicant: {
      relationship: "Parent",
      firstName: "T",
      lastName: "R",
      phone: "1",
      email: "t@example.com",
    },
    copies: 1,
    consents: {
      accurate: true,
      govtId: true,
      terms: true,
      privacy: true,
      refund: true,
      independent: true,
      processingPayment: true,
    },
    signature: "T R",
    pricing: { serviceCents: 12500, rushCents: 0, totalCents: 12500 },
    amountCents: 12500,
  };
}

describe("confidentialData at rest", () => {
  test("encrypted doc contains no plaintext SSN or card material", () => {
    const ssn = "123-45-6789";
    const pan = "4111111111111111";
    const doc = new Order({
      ...baseOrder(),
      confidentialData: {
        ssnEnc: encryptSensitive(ssn),
        cardNumberEnc: encryptSensitive(pan),
        cardExpiryEnc: encryptSensitive("12/30"),
        cardCvcEnc: encryptSensitive("123"),
        keyId: "v1",
        encryptedAt: new Date(),
      },
    });
    assert.equal(doc.validateSync(), undefined);
    const raw = JSON.stringify(doc.toObject());
    assert.ok(!raw.includes(ssn), "raw SSN must not appear in the stored document");
    assert.ok(!raw.includes(pan), "raw PAN must not appear in the stored document");
    assert.ok(!raw.includes("requestorSsn"), "legacy plaintext field must be gone");
    assert.ok(!raw.includes("securityCode"), "legacy plaintext card field must be gone");
    assert.equal(decryptSensitive(doc.confidentialData.ssnEnc), ssn);
    assert.equal(decryptSensitive(doc.confidentialData.cardNumberEnc), pan);
  });
});
