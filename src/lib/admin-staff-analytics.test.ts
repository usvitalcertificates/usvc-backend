import assert from "node:assert/strict";
import test from "node:test";
import {
  adminAnalyticsQuerySchema,
  analyticsDateRange,
  paginateAnalytics,
  summarizeStaffAnalytics,
  workflowMatches,
  type AnalyticsOrder,
} from "./admin-staff-analytics.js";

const date = (value: string) => new Date(`${value}T12:00:00.000Z`);

const orders: AnalyticsOrder[] = [
  {
    _id: "one",
    publicNumber: "USVC-ONE",
    certificate: "BIRTH",
    stateCode: "CA",
    geo: { county: "Orange" },
    rush: true,
    status: "TO_CS",
    auditEvents: [
      { actorId: "agent-a", action: "order_claimed", createdAt: date("2026-09-01") },
      { actorId: "agent-a", action: "order_claimed", createdAt: date("2026-09-02") },
      {
        actorId: "agent-a",
        action: "fulfillment_status_updated",
        metadata: { status: "TO_CS" },
        createdAt: date("2026-09-03"),
      },
    ],
  },
  {
    _id: "two",
    publicNumber: "USVC-TWO",
    certificate: "DEATH",
    stateCode: "NY",
    status: "SUBMITTED",
    auditEvents: [
      { actorId: "agent-b", action: "order_claimed", createdAt: date("2026-09-04") },
      {
        actorId: "agent-a",
        action: "fulfillment_status_updated",
        metadata: { status: "SUBMITTED" },
        createdAt: date("2026-09-05"),
      },
    ],
  },
  {
    _id: "three",
    publicNumber: "USVC-THREE",
    certificate: "BIRTH",
    stateCode: "CA",
    status: "GTG",
    auditEvents: [
      { actorId: "agent-a", action: "order_claimed", createdAt: date("2026-09-06") },
      {
        actorId: "agent-a",
        action: "fulfillment_status_updated",
        metadata: { status: "GTG" },
        createdAt: date("2026-09-07"),
      },
    ],
  },
];

test("analytics counts unique forms, attributes actors, and sorts latest activity", () => {
  const result = summarizeStaffAnalytics(
    orders,
    "agent-a",
    date("2026-09-01"),
    date("2026-09-30"),
    "all",
  );
  assert.deepEqual(result.metrics, {
    ownershipTaken: 2,
    sentToCs: 1,
    markedGtg: 1,
    submittedToAgency: 1,
    totalFormsHandled: 3,
  });
  assert.deepEqual(
    result.rows.map((row) => row.id),
    ["three", "two", "one"],
  );
});

test("analytics applies inclusive ranges and current workflow filtering", () => {
  const result = summarizeStaffAnalytics(
    orders,
    "agent-a",
    date("2026-09-03"),
    date("2026-09-03"),
    "to_cs",
  );
  assert.equal(result.metrics.sentToCs, 1);
  assert.equal(result.metrics.ownershipTaken, 0);
  assert.deepEqual(
    result.rows.map((row) => row.id),
    ["one"],
  );
});

test("workflow groups only the supported operational statuses", () => {
  assert.equal(workflowMatches("PAID", "processing", new Set(["claimed"])), true);
  assert.equal(workflowMatches("IN_REVIEW", "processing", new Set(["claimed"])), true);
  assert.equal(workflowMatches("GTG", "processing", new Set(["claimed"])), true);
  assert.equal(workflowMatches("TO_CS", "to_cs", new Set(["toCs"])), true);
  assert.equal(workflowMatches("GTG", "gtg", new Set(["gtg"])), true);
  assert.equal(workflowMatches("SUBMITTED", "submitted", new Set(["submitted"])), true);
  assert.equal(workflowMatches("TO_CS", "to_cs", new Set(["claimed"])), false);
  assert.equal(workflowMatches("GTG", "gtg", new Set(["claimed"])), false);
  assert.equal(workflowMatches("SUBMITTED", "submitted", new Set(["claimed"])), false);
  assert.equal(workflowMatches("CANCELLED", "processing", new Set(["claimed"])), false);
});

test("To-CS rows match the selected user's To-CS KPI attribution", () => {
  const result = summarizeStaffAnalytics(
    orders,
    "agent-b",
    date("2026-09-01"),
    date("2026-09-30"),
    "to_cs",
  );
  assert.equal(result.metrics.sentToCs, 0);
  assert.equal(result.rows.length, 0);
});

test("GTG filter isolates marked orders and scopes every card to the rows", () => {
  const result = summarizeStaffAnalytics(
    orders,
    "agent-a",
    date("2026-09-01"),
    date("2026-09-30"),
    "gtg",
  );
  assert.deepEqual(result.metrics, {
    ownershipTaken: 1,
    sentToCs: 0,
    markedGtg: 1,
    submittedToAgency: 0,
    totalFormsHandled: 1,
  });
  assert.deepEqual(
    result.rows.map((row) => row.id),
    ["three"],
  );
});

test("analytics query validates dates, workflow, and pagination bounds", () => {
  assert.equal(
    adminAnalyticsQuerySchema.safeParse({ from: "2026-09-30", to: "2026-09-01" }).success,
    false,
  );
  assert.equal(adminAnalyticsQuerySchema.safeParse({ status: "cancelled" }).success, false);
  assert.equal(adminAnalyticsQuerySchema.safeParse({ page: 0 }).success, false);
  assert.deepEqual(adminAnalyticsQuerySchema.parse({}), { status: "all", page: 1, limit: 20 });
});

test("date boundaries include the entire requested days", () => {
  const range = analyticsDateRange("2026-09-01", "2026-09-30");
  assert.equal(range.from?.toISOString(), "2026-09-01T00:00:00.000Z");
  assert.equal(range.to?.toISOString(), "2026-09-30T23:59:59.999Z");
});

test("pagination returns stable metadata and an empty out-of-range page", () => {
  assert.deepEqual(paginateAnalytics([1, 2, 3, 4, 5], 2, 2), {
    rows: [3, 4],
    total: 5,
    page: 2,
    pages: 3,
  });
  assert.deepEqual(paginateAnalytics([1], 3, 20).rows, []);
});
