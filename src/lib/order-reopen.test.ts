import assert from "node:assert/strict";
import test from "node:test";
import { ADMIN_REOPEN_TARGETS, adminReopenSchema, isAllowedAdminReopen } from "./order-reopen.js";

test("ADMIN may rewind an accidental submission", () => {
  assert.equal(isAllowedAdminReopen("SUBMITTED", "IN_REVIEW"), true);
  assert.equal(isAllowedAdminReopen("SUBMITTED", "PAID"), true);
  assert.equal(isAllowedAdminReopen("IN_REVIEW", "PAID"), true);
  assert.equal(isAllowedAdminReopen("TO_CS", "IN_REVIEW"), true);
  assert.equal(isAllowedAdminReopen("GTG", "IN_REVIEW"), true);
});

test("reopen never skips forward or targets a terminal/parked state", () => {
  assert.equal(isAllowedAdminReopen("PAID", "IN_REVIEW"), false);
  assert.equal(isAllowedAdminReopen("PAID", "PAID"), false);
  assert.equal(isAllowedAdminReopen("IN_REVIEW", "SUBMITTED"), false);
  assert.equal(isAllowedAdminReopen("GTG", "SUBMITTED"), false);
  assert.equal(isAllowedAdminReopen("TO_CS", "GTG"), false);
  assert.equal(isAllowedAdminReopen("SUBMITTED", "SUBMITTED"), false);
  assert.deepEqual(ADMIN_REOPEN_TARGETS, ["PAID", "IN_REVIEW"]);
});

test("reopen requires a non-empty reason", () => {
  assert.throws(() => adminReopenSchema.parse({ status: "IN_REVIEW", reason: "  " }));
  assert.throws(() => adminReopenSchema.parse({ status: "IN_REVIEW" }));
  const parsed = adminReopenSchema.parse({
    status: "IN_REVIEW",
    reason: "  Submitted by mistake  ",
  });
  assert.equal(parsed.reason, "Submitted by mistake");
});
