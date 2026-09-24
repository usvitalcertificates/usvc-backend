import assert from "node:assert/strict";
import test from "node:test";
import { canCorrectOrders, canSeePricing, isAdminRole } from "./staff-roles.js";
import { validateCorrection, type CorrectionCandidate } from "./order-validation.js";
import { correctionSchema } from "../routes/staff.js";

test("pricing is visible only to ADMIN and CS", () => {
  assert.equal(canSeePricing("ADMIN"), true);
  assert.equal(canSeePricing("CS"), true);
  assert.equal(canSeePricing("FULFILLMENT"), false);
  assert.equal(canSeePricing("STAFF"), false);
  assert.equal(canSeePricing(undefined), false);
  assert.equal(canSeePricing(null), false);
  assert.equal(canSeePricing(""), false);
});

test("form correction without ownership is limited to ADMIN and CS", () => {
  assert.equal(canCorrectOrders("ADMIN"), true);
  assert.equal(canCorrectOrders("CS"), true);
  assert.equal(canCorrectOrders("FULFILLMENT"), false);
  assert.equal(canCorrectOrders("STAFF"), false);
  assert.equal(canCorrectOrders(undefined), false);
});

test("admin check is ADMIN-only", () => {
  assert.equal(isAdminRole("ADMIN"), true);
  assert.equal(isAdminRole("CS"), false);
  assert.equal(isAdminRole("FULFILLMENT"), false);
});

test("correction schema accepts a partial applicant + geo patch", () => {
  const parsed = correctionSchema.parse({
    applicant: { firstName: "Jordan", phone: "+15551234567" },
    geo: { county: "Alpine", city: "Markleeville" },
    note: "Fixed spelling.",
  });
  assert.equal(parsed.applicant?.firstName, "Jordan");
  assert.equal(parsed.geo?.city, "Markleeville");
});

test("correction schema accepts SSN, card, and delivery patches", () => {
  const parsed = correctionSchema.parse({
    requestorSsn: "123-45-6789",
    paymentCard: { number: "4111111111111111", expiry: "12/30", securityCode: "123" },
    deliveryMethod: "expedited",
    destinationType: "domestic",
  });
  assert.equal(parsed.requestorSsn, "123-45-6789");
  assert.equal(parsed.paymentCard?.securityCode, "123");
});

test("correction schema rejects empty bodies", () => {
  assert.throws(() => correctionSchema.parse({}));
  assert.throws(() => correctionSchema.parse({ note: "only a note" }));
  assert.throws(() => correctionSchema.parse({ requestorSsn: "" }));
});

const validCandidate: CorrectionCandidate = {
  certificate: "BIRTH",
  stateCode: "CA",
  applicant: {
    relationship: "Self",
    relationshipOther: "",
    firstName: "Jordan",
    middleName: "",
    lastName: "Lee",
    dateOfBirth: "1990-01-15",
    phone: "+15551234567",
    email: "jordan@example.com",
  },
  subject: { firstName: "Jordan", lastName: "Lee", eventDate: "1990-01-15" },
  family: {
    motherFirstName: "Maria",
    motherCurrentLastName: "Lee",
    motherLastName: "Garcia",
  },
  addresses: {
    home: { line1: "1 Main St", city: "Markleeville", state: "CA", postalCode: "96120" },
    shipping: { line1: "1 Main St", city: "Markleeville", state: "CA", postalCode: "96120" },
    billing: { line1: "1 Main St", city: "Markleeville", state: "CA", postalCode: "96120" },
  },
  county: "Alpine",
  city: "Markleeville",
  reason: "Personal records",
  reasonOther: "",
  deliveryMethod: "regular",
  destinationType: "domestic",
};

test("validateCorrection accepts a complete valid correction", () => {
  const result = validateCorrection({
    ...validCandidate,
    requestorSsn: "123-45-6789",
    paymentCard: { number: "4111111111111111", expiry: "12/30", securityCode: "123" },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, {});
});

test("validateCorrection flags bad contact, geo, SSN, and card values", () => {
  const bad = validateCorrection({
    ...validCandidate,
    applicant: { ...validCandidate.applicant, email: "bad", phone: "555" },
    county: "Nowhere",
    city: "Nocity",
    requestorSsn: "000-00-0000",
    paymentCard: { number: "1234", expiry: "13/99", securityCode: "12" },
  });
  assert.equal(bad.ok, false);
  for (const key of [
    "applicant.email",
    "applicant.phone",
    "county",
    "requestorSsn",
    "paymentCard.number",
    "paymentCard.expiry",
    "paymentCard.securityCode",
  ]) {
    assert.ok(bad.errors[key], `expected error for ${key}`);
  }
});

test("validateCorrection refuses blanked required subject/family fields", () => {
  const bad = validateCorrection({
    ...validCandidate,
    subject: { firstName: "", lastName: "Lee", eventDate: "1990-01-15" },
    family: { motherFirstName: "", motherCurrentLastName: "Lee", motherLastName: "Garcia" },
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors["subject.firstName"]);
  assert.ok(bad.errors["family.motherFirstName"]);
});
