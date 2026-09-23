import assert from "node:assert/strict";
import test from "node:test";
import {
  isAllowedStaffStatusTransition,
  isExceptionStatus,
  publicTrackingStatus,
} from "./customer-tracking.js";

test("shows the paid customer milestones without internal status codes", () => {
  const paidAt = new Date("2026-09-22T12:00:00.000Z");
  const result = publicTrackingStatus({
    paymentStatus: "PAID",
    status: "SUBMITTED",
    updatedAt: paidAt,
    customerTimeline: { paymentSuccessfulAt: paidAt, orderReceivedAt: paidAt },
  });

  assert.equal(result.currentStatus, "Order Processed – Submitted to the Govt Agency");
  assert.deepEqual(
    result.timeline.map((entry) => entry.label),
    [
      "Payment Successful",
      "Order Received",
      "Order Processing",
      "Order Processed – Submitted to the Govt Agency",
    ],
  );
  assert.match(result.notice ?? "", /Government-agency processing/);
});

test("does not show successful milestones for failed payments", () => {
  const result = publicTrackingStatus({ paymentStatus: "FAILED", status: "AWAITING_PAYMENT" });
  assert.equal(result.currentStatus, "Payment Unsuccessful");
  assert.deepEqual(result.timeline, []);
});

test("allows staff to move a paid order forward but never to alter payment status", () => {
  assert.equal(isAllowedStaffStatusTransition("PAID", "IN_REVIEW"), true);
  assert.equal(isAllowedStaffStatusTransition("IN_REVIEW", "SUBMITTED"), true);
  // SUBMITTED is terminal: "Order Processed – Submitted to the Govt Agency" is last.
  assert.equal(isAllowedStaffStatusTransition("SUBMITTED", "COMPLETED"), false);
  assert.equal(isAllowedStaffStatusTransition("SUBMITTED", "IN_REVIEW"), false);
  assert.equal(isAllowedStaffStatusTransition("PAID", "SUBMITTED"), false);
});

test("allows exception parking with a note and resume, never skipping ahead", () => {
  assert.equal(isAllowedStaffStatusTransition("IN_REVIEW", "ON_HOLD"), true);
  assert.equal(isAllowedStaffStatusTransition("IN_REVIEW", "NEED_INFO"), true);
  assert.equal(isAllowedStaffStatusTransition("ON_HOLD", "IN_REVIEW"), true);
  assert.equal(isAllowedStaffStatusTransition("NEED_INFO", "IN_REVIEW"), true);
  assert.equal(isAllowedStaffStatusTransition("PAID", "ON_HOLD"), false);
  assert.equal(isAllowedStaffStatusTransition("ON_HOLD", "SUBMITTED"), false);
  assert.equal(isExceptionStatus("ON_HOLD"), true);
  assert.equal(isExceptionStatus("SUBMITTED"), false);
});

test("shows a neutral support message for exception statuses", () => {
  const result = publicTrackingStatus({
    paymentStatus: "PAID",
    status: "ON_HOLD",
    updatedAt: new Date("2026-09-22T12:00:00.000Z"),
    customerTimeline: {},
  });
  assert.equal(result.currentStatus, "Order Processing");
  assert.match(result.notice ?? "", /support/);
});
