import assert from "node:assert/strict";
import test from "node:test";
import { Order } from "../models/order.js";
import {
  createOrderSchema,
  validateGeoSelection,
  validateOrderSubmission,
} from "./order-validation.js";

function base(certificate: "BIRTH" | "DEATH" | "MARRIAGE" | "DIVORCE" = "BIRTH") {
  return {
    antiAbuse: { honeypot: "", formStartedAt: Date.now() - 60_000 },
    stateSlug: "alabama",
    stateCode: "AL",
    stateName: "Alabama",
    certificate,
    county: "Jefferson",
    city: "Birmingham",
    reason: "Passport / travel",
    applicant: {
      relationship: "Parent",
      firstName: "Jane",
      lastName: "Doe",
      phone: "555-0100",
      email: "jane@example.com",
    },
    requestorSsn: "123-45-6789",
    addresses: {
      home: { line1: "1 Main St", city: "Birmingham", state: "AL", postalCode: "35203" },
      shipping: { line1: "1 Main St", city: "Birmingham", state: "AL", postalCode: "35203" },
      billing: { line1: "1 Main St", city: "Birmingham", state: "AL", postalCode: "35203" },
    },
    destinationType: "domestic" as const,
    copies: 1,
    rush: false,
    consents: {
      accurate: true,
      govtId: true,
      terms: true,
      privacy: true,
      refund: true,
      independent: true,
      processingPayment: true,
    },
    processingAuthorization: {
      accepted: true as const,
      text: "I authorize USVC to charge the complete total shown on my order.",
      acceptedAt: new Date().toISOString(),
    },
    paymentCard: { number: "4111 1111 1111 1111", expiry: "12/30", securityCode: "123" },
    signature: "Jane Doe",
    totalCents: 12500,
  };
}

const SUBJECTS = {
  BIRTH: {
    subject: { firstName: "Baby", lastName: "Doe", suffix: "None", eventDate: "2020-01-15" },
    family: {
      motherFirstName: "Jane",
      motherCurrentLastName: "Doe",
      motherLastName: "Smith",
      fatherStatus: "Unknown",
    },
  },
  DEATH: { subject: { firstName: "John", lastName: "Doe", eventDate: "2024-05-01" }, family: {} },
  MARRIAGE: {
    subject: { firstName: "Jane", lastName: "Doe", eventDate: "2019-06-20" },
    family: { spouseFirstName: "John", spouseLastName: "Doe" },
  },
  DIVORCE: {
    subject: { firstName: "Jane", lastName: "Doe" },
    family: { spouseFirstName: "John", spouseLastName: "Doe" },
  },
} as const;

for (const cert of ["BIRTH", "DEATH", "MARRIAGE", "DIVORCE"] as const) {
  test(`accepts a complete ${cert} application`, () => {
    const input = createOrderSchema.parse({ ...base(cert), ...SUBJECTS[cert] });
    const result = validateOrderSubmission(input);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });
}

test("removes legacy name-history and alternate-spelling subject fields", () => {
  const input = createOrderSchema.parse({
    ...base("BIRTH"),
    ...SUBJECTS.BIRTH,
    subject: {
      ...SUBJECTS.BIRTH.subject,
      subjectNameChanged: "Yes",
      subjectSpelling: "Yes",
      previousFirstName: "Old",
      previousMiddleName: "Name",
      previousLastName: "Doe",
      nameChangeContext: "Marriage",
      alternateSpelling: "Doh",
    },
  });
  assert.equal(input.subject["subjectNameChanged"], undefined);
  assert.equal(input.subject["subjectSpelling"], undefined);
  assert.equal(input.subject["previousLastName"], undefined);
  assert.equal(input.subject["alternateSpelling"], undefined);
  assert.equal(input.subject["firstName"], "Baby");
});

test("rejects missing required birth fields", () => {
  const input = createOrderSchema.parse({
    ...base("BIRTH"),
    subject: { firstName: "" },
    family: {},
  });
  const result = validateOrderSubmission(input);
  assert.equal(result.ok, false);
  assert.ok(result.errors["subject.firstName"] ?? result.errors["subject.lastName"]);
});

test("requires father names when father status is known", () => {
  const input = createOrderSchema.parse({
    ...base("BIRTH"),
    ...SUBJECTS.BIRTH,
    family: { ...SUBJECTS.BIRTH.family, fatherStatus: "Known" },
  });
  const result = validateOrderSubmission(input);
  assert.equal(result.ok, false);
  assert.ok(result.errors["family.fatherFirstName"]);
});

test("rejects wrong totals and honeypot fills", () => {
  const badTotal = createOrderSchema.parse({ ...base("BIRTH"), ...SUBJECTS.BIRTH, totalCents: 1 });
  assert.equal(validateOrderSubmission(badTotal).ok, false);
  const bot = createOrderSchema.parse({
    ...base("BIRTH"),
    ...SUBJECTS.BIRTH,
    antiAbuse: { honeypot: "x", formStartedAt: Date.now() - 60_000 },
  });
  assert.equal(validateOrderSubmission(bot).ok, false);
});

test("validates county/city against the Alabama dataset", () => {
  assert.equal(validateGeoSelection("AL", "Jefferson", "Birmingham"), true);
  assert.equal(validateGeoSelection("AL", "Nope", "Birmingham"), false);
  assert.equal(validateGeoSelection("AL", "Jefferson", "Nowhere"), false);
});

test("requires SSN and DOB for California birth records", () => {
  const input = createOrderSchema.parse({
    ...base("BIRTH"),
    ...SUBJECTS.BIRTH,
    stateSlug: "california",
    stateCode: "CA",
    stateName: "California",
    county: "Los Angeles",
    city: "Los Angeles",
    requestorSsn: "",
  });
  const result = validateOrderSubmission(input);
  assert.equal(result.ok, false);
  assert.ok(result.errors["requestorSsn"]);
});

test("order document stores requestorSsn as plaintext alongside form data", () => {
  const doc = new Order({
    publicNumber: "USVC-BI-20260921-TEST01",
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
    requestorSsn: "123-45-6789",
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
  });
  assert.equal(doc.validateSync(), undefined);
  assert.equal(doc.requestorSsn, "123-45-6789");
});

test("rejects 21 copies (max is 20)", () => {
  const schema = createOrderSchema.safeParse({ ...base("BIRTH"), ...SUBJECTS.BIRTH, copies: 21 });
  assert.equal(schema.success, false);
});

test("accepts 20 copies", () => {
  const input = createOrderSchema.parse({
    ...base("BIRTH"),
    ...SUBJECTS.BIRTH,
    copies: 20,
    totalCents: 20 * 12500,
  });
  assert.equal(
    validateOrderSubmission(input).ok,
    true,
    JSON.stringify(validateOrderSubmission(input).errors),
  );
});

test("validates card brand, Luhn, expiry, and CVV", () => {
  const good = createOrderSchema.parse({ ...base("BIRTH"), ...SUBJECTS.BIRTH });
  assert.equal(validateOrderSubmission(good).ok, true);
  for (const [patch, key] of [
    [{ number: "378282246310005" }, "paymentCard.number"],
    [{ number: "6011111111111117" }, "paymentCard.number"],
    [{ number: "4111111111111112" }, "paymentCard.number"],
    [{ expiry: "01/20" }, "paymentCard.expiry"],
    [{ expiry: "13/30" }, "paymentCard.expiry"],
    [{ securityCode: "12" }, "paymentCard.securityCode"],
    [{ securityCode: "1234" }, "paymentCard.securityCode"],
  ] as const) {
    const input = createOrderSchema.parse({
      ...base("BIRTH"),
      ...SUBJECTS.BIRTH,
      paymentCard: { number: "4111111111111111", expiry: "12/30", securityCode: "123", ...patch },
    });
    const result = validateOrderSubmission(input);
    assert.equal(result.ok, false, JSON.stringify(patch));
    assert.ok(result.errors[key], JSON.stringify(result.errors));
  }
  const mc = createOrderSchema.parse({
    ...base("BIRTH"),
    ...SUBJECTS.BIRTH,
    paymentCard: { number: "5555555555554444", expiry: "12/30", securityCode: "123" },
  });
  assert.equal(validateOrderSubmission(mc).ok, true);
});
