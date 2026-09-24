import assert from "node:assert/strict";
import test from "node:test";
import { queueAssignmentMatch } from "./staff-queue.js";

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
