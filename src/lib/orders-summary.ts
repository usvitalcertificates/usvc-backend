import { z } from "zod";
import { analyticsDateRange } from "./admin-staff-analytics.js";

export const CERTIFICATES = ["BIRTH", "DEATH", "MARRIAGE", "DIVORCE"] as const;

export type SummaryCertificate = (typeof CERTIFICATES)[number];

const dateOnly = /^\d{4}-\d{2}-\d{2}$/;

export const ordersSummaryQuerySchema = z
  .object({
    from: z.string().regex(dateOnly).optional(),
    to: z.string().regex(dateOnly).optional(),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: "From date must be on or before to date.",
  });

export type OrdersSummaryQuery = z.infer<typeof ordersSummaryQuerySchema>;

export interface CertificateSlice {
  certificate: string;
  orders: number;
  revenueCents: number;
}

export interface StateSlice {
  stateCode: string;
  orders: number;
  revenueCents: number;
}

export interface CertificateStateSlice {
  certificate: string;
  stateCode: string;
  orders: number;
  revenueCents: number;
}

export interface StatusSlice {
  status: string;
  orders: number;
}

export interface OrdersSummaryTotals {
  orders: number;
  revenueCents: number;
  rushOrders: number;
}

export interface OrdersSummary {
  range: { from: string | null; to: string | null };
  certificates: CertificateSlice[];
  states: StateSlice[];
  matrix: CertificateStateSlice[];
  statuses: StatusSlice[];
  totals: OrdersSummaryTotals;
}

/** Base match for business analytics: paid orders only, inside the range. */
export function summaryBaseMatch(query: OrdersSummaryQuery): Record<string, unknown> {
  const { from, to } = analyticsDateRange(query.from, query.to);
  const match: Record<string, unknown> = { paymentStatus: "PAID" };
  if (from || to) {
    match["createdAt"] = {
      ...(from ? { $gte: from } : {}),
      ...(to ? { $lte: to } : {}),
    };
  }
  return match;
}

/**
 * Single aggregation returning every dashboard dimension at once, so adding
 * a chart later is frontend-only work. Amounts are integer cents; no PII.
 */
export function summaryFacetPipeline(query: OrdersSummaryQuery): Record<string, unknown>[] {
  return [
    { $match: summaryBaseMatch(query) },
    {
      $facet: {
        byCertificate: [
          {
            $group: {
              _id: "$certificate",
              orders: { $sum: 1 },
              revenueCents: { $sum: "$amountCents" },
            },
          },
          { $project: { _id: 0, certificate: "$_id", orders: 1, revenueCents: 1 } },
          { $sort: { orders: -1 } },
        ],
        byState: [
          {
            $group: {
              _id: "$stateCode",
              orders: { $sum: 1 },
              revenueCents: { $sum: "$amountCents" },
            },
          },
          { $project: { _id: 0, stateCode: "$_id", orders: 1, revenueCents: 1 } },
          { $sort: { orders: -1 } },
        ],
        byCertificateState: [
          {
            $group: {
              _id: { certificate: "$certificate", stateCode: "$stateCode" },
              orders: { $sum: 1 },
              revenueCents: { $sum: "$amountCents" },
            },
          },
          {
            $project: {
              _id: 0,
              certificate: "$_id.certificate",
              stateCode: "$_id.stateCode",
              orders: 1,
              revenueCents: 1,
            },
          },
          { $sort: { orders: -1 } },
        ],
        byStatus: [
          { $group: { _id: "$status", orders: { $sum: 1 } } },
          { $project: { _id: 0, status: "$_id", orders: 1 } },
          { $sort: { orders: -1 } },
        ],
        totals: [
          {
            $group: {
              _id: null,
              orders: { $sum: 1 },
              revenueCents: { $sum: "$amountCents" },
              rushOrders: { $sum: { $cond: ["$rush", 1, 0] } },
            },
          },
          { $project: { _id: 0, orders: 1, revenueCents: 1, rushOrders: 1 } },
        ],
      },
    },
  ];
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Normalize one facet result into the dashboard shape (missing facets → empty/zero). */
export function normalizeSummary(
  query: OrdersSummaryQuery,
  facet: Record<string, unknown[]>,
): OrdersSummary {
  const certificates = (facet["byCertificate"] ?? []).map((row) => {
    const record = row as Record<string, unknown>;
    return {
      certificate: asString(record["certificate"]),
      orders: asNumber(record["orders"]),
      revenueCents: asNumber(record["revenueCents"]),
    };
  });
  const states = (facet["byState"] ?? []).map((row) => {
    const record = row as Record<string, unknown>;
    return {
      stateCode: asString(record["stateCode"]),
      orders: asNumber(record["orders"]),
      revenueCents: asNumber(record["revenueCents"]),
    };
  });
  const matrix = (facet["byCertificateState"] ?? []).map((row) => {
    const record = row as Record<string, unknown>;
    return {
      certificate: asString(record["certificate"]),
      stateCode: asString(record["stateCode"]),
      orders: asNumber(record["orders"]),
      revenueCents: asNumber(record["revenueCents"]),
    };
  });
  const statuses = (facet["byStatus"] ?? []).map((row) => {
    const record = row as Record<string, unknown>;
    return { status: asString(record["status"]), orders: asNumber(record["orders"]) };
  });
  const totalRow = (facet["totals"]?.[0] ?? {}) as Record<string, unknown>;
  return {
    range: { from: query.from ?? null, to: query.to ?? null },
    certificates,
    states,
    matrix,
    statuses,
    totals: {
      orders: asNumber(totalRow["orders"]),
      revenueCents: asNumber(totalRow["revenueCents"]),
      rushOrders: asNumber(totalRow["rushOrders"]),
    },
  };
}
