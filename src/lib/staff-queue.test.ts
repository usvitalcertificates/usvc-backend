import assert from "node:assert/strict";
import test from "node:test";
import { latestSentToCsAt, queueAssignmentMatch } from "./staff-queue.js";

const SUB = "66f123456789abcdef012345";

test("queue shows all orders by default for every role", () => {
  assert.deepEqual(queueAssignmentMatch("all", SUB), {});
});

test("assigned=mine scopes to the caller", () => {
  assert.deepEqual(queueAssignmentMatch("mine", SUB), { assignedTo: SUB });
});

test("assigned=unassigned scopes to the open pool", () => {
  assert.deepEqual(queueAssignmentMatch("unassigned", SUB), { assignedTo: null });
});

test("CS queue age uses the latest To-CS handoff, not a later audit event", () => {
  const sentAt = latestSentToCsAt([
    {
      action: "fulfillment_status_updated",
      metadata: { status: "TO_CS" },
      createdAt: new Date("2026-09-20T09:00:00.000Z"),
    },
    { action: "form_corrected", createdAt: new Date("2026-09-20T10:00:00.000Z") },
    {
      action: "fulfillment_status_updated",
      metadata: { status: "TO_CS" },
      createdAt: new Date("2026-09-21T11:30:00.000Z"),
    },
  ]);

  assert.equal(sentAt?.toISOString(), "2026-09-21T11:30:00.000Z");
});
