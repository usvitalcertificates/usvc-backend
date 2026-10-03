import assert from "node:assert/strict";
import test from "node:test";
import { resolveSubmissionReuse } from "./order-reuse.js";

test("creates when no order carries the key", () => {
  assert.deepEqual(resolveSubmissionReuse(null), { action: "create" });
});

test("retries update an unpaid order", () => {
  for (const paymentStatus of ["PENDING", "FAILED"]) {
    assert.deepEqual(resolveSubmissionReuse({ _id: "abc", publicNumber: "US1", paymentStatus }), {
      action: "reuse",
    });
  }
});

test("retrying a paid order is a conflict pointing at it", () => {
  assert.deepEqual(
    resolveSubmissionReuse({ _id: "abc", publicNumber: "US1", paymentStatus: "PAID" }),
    { action: "conflict", orderId: "abc", publicNumber: "US1" },
  );
});
