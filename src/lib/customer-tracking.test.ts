import assert from "node:assert/strict";
import test from "node:test";
import {
  attentionPriority,
  isAllowedStaffStatusTransition,
  isExceptionStatus,
  isParkedStatus,
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

test("allows sending To CS with a note, GTG, and resume — never skipping ahead", () => {
  assert.equal(isAllowedStaffStatusTransition("IN_REVIEW", "TO_CS"), true);
  assert.equal(isAllowedStaffStatusTransition("TO_CS", "GTG"), true);
  assert.equal(isAllowedStaffStatusTransition("GTG", "IN_REVIEW"), true);
  // Nothing leaves TO_CS except via GTG; GTG never submits directly.
  assert.equal(isAllowedStaffStatusTransition("TO_CS", "IN_REVIEW"), false);
  assert.equal(isAllowedStaffStatusTransition("TO_CS", "SUBMITTED"), false);
  assert.equal(isAllowedStaffStatusTransition("GTG", "SUBMITTED"), false);
  assert.equal(isAllowedStaffStatusTransition("PAID", "TO_CS"), false);
  assert.equal(isAllowedStaffStatusTransition("PAID", "GTG"), false);
  // Only sending To CS requires a note; GTG is completion without one.
  assert.equal(isExceptionStatus("TO_CS"), true);
  assert.equal(isExceptionStatus("GTG"), false);
  assert.equal(isExceptionStatus("SUBMITTED"), false);
  assert.equal(isExceptionStatus("ON_HOLD"), false);
  // Both park states stay internal.
  assert.equal(isParkedStatus("TO_CS"), true);
  assert.equal(isParkedStatus("GTG"), true);
  assert.equal(isParkedStatus("IN_REVIEW"), false);
  assert.equal(isParkedStatus("SUBMITTED"), false);
});

test("shows a neutral support message for To CS and GTG", () => {
  for (const status of ["TO_CS", "GTG"]) {
    const result = publicTrackingStatus({
      paymentStatus: "PAID",
      status,
      updatedAt: new Date("2026-09-22T12:00:00.000Z"),
      customerTimeline: {},
    });
    assert.equal(result.currentStatus, "Order Processing");
    assert.match(result.notice ?? "", /support/);
  }
});

test("ranks parked orders first, then rush, then everything else", () => {
  assert.equal(attentionPriority("TO_CS", false), 0);
  assert.equal(attentionPriority("GTG", false), 0);
  assert.equal(attentionPriority("GTG", true), 0);
  assert.equal(attentionPriority("PAID", true), 1);
  assert.equal(attentionPriority("IN_REVIEW", true), 1);
  assert.equal(attentionPriority("PAID", false), 2);
  assert.equal(attentionPriority("SUBMITTED", false), 2);
});
