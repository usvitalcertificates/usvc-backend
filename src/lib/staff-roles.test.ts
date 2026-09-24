import assert from "node:assert/strict";
import test from "node:test";
import { canCorrectOrders, canSeePricing, isAdminRole } from "./staff-roles.js";
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

test("correction schema rejects empty bodies and bad phone", () => {
  assert.throws(() => correctionSchema.parse({}));
  assert.throws(() => correctionSchema.parse({ note: "only a note" }));
  assert.throws(() => correctionSchema.parse({ applicant: { phone: "not-a-phone" } }));
});
