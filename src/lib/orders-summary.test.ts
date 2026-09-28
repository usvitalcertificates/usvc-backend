import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSummary,
  ordersSummaryQuerySchema,
  summaryBaseMatch,
  summaryFacetPipeline,
} from "./orders-summary.js";

describe("orders summary query validation", () => {
  test("accepts empty and valid ranges", () => {
    assert.deepEqual(ordersSummaryQuerySchema.parse({}), {});
    assert.deepEqual(ordersSummaryQuerySchema.parse({ from: "2026-09-01", to: "2026-09-30" }), {
      from: "2026-09-01",
      to: "2026-09-30",
    });
  });

  test("rejects malformed dates and inverted ranges", () => {
    assert.throws(() => ordersSummaryQuerySchema.parse({ from: "09-01-2026" }));
    assert.throws(() => ordersSummaryQuerySchema.parse({ from: "2026-09-30", to: "2026-09-01" }));
  });
});

describe("summary base match", () => {
  test("matches paid orders only when no range", () => {
    assert.deepEqual(summaryBaseMatch({}), { paymentStatus: "PAID" });
  });

  test("bounds createdAt to UTC day edges", () => {
    const match = summaryBaseMatch({ from: "2026-09-01", to: "2026-09-07" }) as {
      createdAt: { $gte: Date; $lte: Date };
    };
    assert.equal(match["paymentStatus"], "PAID");
    assert.equal(match["createdAt"].$gte.toISOString(), "2026-09-01T00:00:00.000Z");
    assert.equal(match["createdAt"].$lte.toISOString(), "2026-09-07T23:59:59.999Z");
  });
});

describe("summary facet pipeline", () => {
  test("returns match plus five facets", () => {
    const [match, facet] = summaryFacetPipeline({}) as [
      Record<string, unknown>,
      { $facet: Record<string, unknown[]> },
    ];
    assert.deepEqual(match, { $match: { paymentStatus: "PAID" } });
    assert.deepEqual(Object.keys(facet.$facet).sort(), [
      "byCertificate",
      "byCertificateState",
      "byState",
      "byStatus",
      "totals",
    ]);
  });
});

describe("normalize summary", () => {
  test("maps facets and zeroes missing data", () => {
    const summary = normalizeSummary(
      { from: "2026-09-01", to: null as unknown as undefined },
      {
        byCertificate: [{ certificate: "BIRTH", orders: 3, revenueCents: 44700 }],
        byState: [{ stateCode: "CA", orders: 2, revenueCents: 29800 }],
        byCertificateState: [
          { certificate: "BIRTH", stateCode: "CA", orders: 2, revenueCents: 29800 },
        ],
        byStatus: [{ status: "SUBMITTED", orders: 3 }],
        totals: [{ orders: 3, revenueCents: 44700, rushOrders: 1 }],
      },
    );
    assert.equal(summary.range.from, "2026-09-01");
    assert.equal(summary.totals.orders, 3);
    assert.equal(summary.totals.revenueCents, 44700);
    assert.equal(summary.totals.rushOrders, 1);
    assert.equal(summary.certificates[0]?.certificate, "BIRTH");
    assert.equal(summary.states[0]?.stateCode, "CA");
    assert.equal(summary.matrix[0]?.orders, 2);
    assert.equal(summary.statuses[0]?.status, "SUBMITTED");
  });

  test("empty facet yields zeroed summary", () => {
    const summary = normalizeSummary({}, {});
    assert.deepEqual(summary.totals, { orders: 0, revenueCents: 0, rushOrders: 0 });
    assert.deepEqual(summary.certificates, []);
    assert.deepEqual(summary.range, { from: null, to: null });
  });
});
