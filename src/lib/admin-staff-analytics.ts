import { z } from "zod";

export const ANALYTICS_WORKFLOWS = ["all", "processing", "to_cs", "gtg", "submitted"] as const;

export type AnalyticsWorkflow = (typeof ANALYTICS_WORKFLOWS)[number];

export interface AnalyticsAuditEvent {
  actorId?: string;
  action?: string;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

export interface AnalyticsOrder {
  _id: unknown;
  publicNumber: string;
  certificate: string;
  stateCode: string;
  geo?: { county?: string };
  rush?: boolean;
  status: string;
  assignedTo?: unknown;
  auditEvents?: AnalyticsAuditEvent[];
}

export interface AnalyticsOrderRow {
  id: string;
  publicNumber: string;
  certificate: string;
  stateCode: string;
  county: string;
  rush: boolean;
  status: string;
  latestActivityAt: Date;
  assignedTo: string | null;
}

const PROCESSING_STATUSES = new Set(["PAID", "IN_REVIEW", "GTG"]);
const dateOnly = /^\d{4}-\d{2}-\d{2}$/;

export const adminAnalyticsQuerySchema = z
  .object({
    from: z.string().regex(dateOnly).optional(),
    to: z.string().regex(dateOnly).optional(),
    status: z.enum(ANALYTICS_WORKFLOWS).default("all"),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: "From date must be on or before to date.",
  });

export function analyticsDateRange(from?: string, to?: string) {
  return {
    from: from ? new Date(`${from}T00:00:00.000Z`) : undefined,
    to: to ? new Date(`${to}T23:59:59.999Z`) : undefined,
  };
}

export function paginateAnalytics<T>(rows: T[], page: number, limit: number) {
  const total = rows.length;
  return {
    rows: rows.slice((page - 1) * limit, page * limit),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

function eventKind(event: AnalyticsAuditEvent): "claimed" | "toCs" | "gtg" | "submitted" | null {
  if (event.action === "order_claimed") return "claimed";
  if (event.action !== "fulfillment_status_updated") return null;
  if (event.metadata?.["status"] === "TO_CS") return "toCs";
  if (event.metadata?.["status"] === "GTG") return "gtg";
  if (event.metadata?.["status"] === "SUBMITTED") return "submitted";
  return null;
}

export function workflowMatches(
  status: string,
  workflow: AnalyticsWorkflow,
  actions: Set<"claimed" | "toCs" | "gtg" | "submitted"> = new Set(),
): boolean {
  if (workflow === "all") return true;
  if (workflow === "processing") return actions.has("claimed") && PROCESSING_STATUSES.has(status);
  if (workflow === "to_cs") return actions.has("toCs");
  if (workflow === "gtg") return actions.has("gtg");
  return actions.has("submitted");
}

export function summarizeStaffAnalytics(
  orders: AnalyticsOrder[],
  staffId: string,
  from: Date | undefined,
  to: Date | undefined,
  workflow: AnalyticsWorkflow,
) {
  const claimed = new Set<string>();
  const toCs = new Set<string>();
  const gtg = new Set<string>();
  const submitted = new Set<string>();
  const rows: AnalyticsOrderRow[] = [];

  for (const order of orders) {
    const orderId = String(order._id);
    let latestActivityAt: Date | null = null;
    const actions = new Set<"claimed" | "toCs" | "gtg" | "submitted">();
    for (const event of order.auditEvents ?? []) {
      const at = event.createdAt;
      if (event.actorId !== staffId || !at || (from && at < from) || (to && at > to)) continue;
      const kind = eventKind(event);
      if (!kind) continue;
      actions.add(kind);
      if (!latestActivityAt || at > latestActivityAt) latestActivityAt = at;
    }
    if (!latestActivityAt || !workflowMatches(order.status, workflow, actions)) continue;
    // Metrics follow the same date + workflow filters as the rows, so the
    // KPI cards always describe exactly what is listed below them.
    for (const kind of actions) {
      if (kind === "claimed") claimed.add(orderId);
      if (kind === "toCs") toCs.add(orderId);
      if (kind === "gtg") gtg.add(orderId);
      if (kind === "submitted") submitted.add(orderId);
    }
    rows.push({
      id: orderId,
      publicNumber: order.publicNumber,
      certificate: order.certificate,
      stateCode: order.stateCode,
      county: order.geo?.county ?? "",
      rush: order.rush ?? false,
      status: order.status,
      latestActivityAt,
      assignedTo: order.assignedTo ? String(order.assignedTo) : null,
    });
  }

  rows.sort((a, b) => b.latestActivityAt.getTime() - a.latestActivityAt.getTime());
  const handled = new Set([...claimed, ...toCs, ...gtg, ...submitted]);
  return {
    metrics: {
      ownershipTaken: claimed.size,
      sentToCs: toCs.size,
      markedGtg: gtg.size,
      submittedToAgency: submitted.size,
      totalFormsHandled: handled.size,
    },
    rows,
  };
}
