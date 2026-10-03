/** Retry-reuse decisions for straight-through payment.
 *  One submissionKey = one logical order: a retry updates the unpaid order
 *  instead of creating a duplicate, and a retry of a paid order is a
 *  conflict that routes to the existing confirmation. Pure logic — the route
 *  owns all I/O. */

export interface ReusableOrderSummary {
  _id: unknown;
  publicNumber: string;
  paymentStatus: string;
}

export type ReuseDecision =
  | { action: "create" }
  | { action: "conflict"; orderId: string; publicNumber: string }
  | { action: "reuse" };

export function resolveSubmissionReuse(existing: ReusableOrderSummary | null): ReuseDecision {
  if (!existing) return { action: "create" };
  if (existing.paymentStatus === "PAID") {
    return {
      action: "conflict",
      orderId: String(existing._id),
      publicNumber: existing.publicNumber,
    };
  }
  return { action: "reuse" };
}
