import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedStaffStatusTransition, publicTrackingStatus } from "./customer-tracking.js";

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
  assert.equal(isAllowedStaffStatusTransition("SUBMITTED", "COMPLETED"), true);
  assert.equal(isAllowedStaffStatusTransition("PAID", "COMPLETED"), false);
  assert.equal(isAllowedStaffStatusTransition("COMPLETED", "PAID"), false);
});
