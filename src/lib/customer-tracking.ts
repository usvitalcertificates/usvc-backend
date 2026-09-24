export const CUSTOMER_TRACKING_STEPS = [
  { key: "paymentSuccessfulAt", label: "Payment Successful" },
  { key: "orderReceivedAt", label: "Order Received" },
  { key: "processingAt", label: "Order Processing" },
  { key: "submittedToAgencyAt", label: "Order Processed – Submitted to the Govt Agency" },
] as const;

type TimelineKey = (typeof CUSTOMER_TRACKING_STEPS)[number]["key"];

type TrackableOrder = {
  paymentStatus: string;
  status: string;
  createdAt?: Date;
  updatedAt?: Date;
  customerTimeline?: Partial<Record<TimelineKey, Date>>;
};

export function publicTrackingStatus(order: TrackableOrder) {
  const updatedAt = order.updatedAt ?? order.createdAt ?? new Date();
  if (order.paymentStatus !== "PAID") {
    const currentStatus =
      order.paymentStatus === "FAILED"
        ? "Payment Unsuccessful"
        : order.paymentStatus === "REFUNDED"
          ? "Payment Refunded"
          : "Payment Pending";
    return {
      currentStatus,
      timeline: [],
      notice:
        order.paymentStatus === "PENDING"
          ? "Your payment has not yet been confirmed."
          : "This order requires support assistance. Please contact support@usvitalcertificates.org.",
      lastUpdatedAt: updatedAt,
    };
  }

  const timeline = order.customerTimeline ?? {};
  const fallbackKeys: TimelineKey[] = ["paymentSuccessfulAt", "orderReceivedAt"];
  if (order.status === "IN_REVIEW") fallbackKeys.push("processingAt");
  if (order.status === "SUBMITTED") fallbackKeys.push("processingAt", "submittedToAgencyAt");

  const entries = CUSTOMER_TRACKING_STEPS.filter(
    (step) => timeline[step.key] || fallbackKeys.includes(step.key),
  ).map((step) => ({
    label: step.label,
    occurredAt: timeline[step.key] ?? updatedAt,
  }));

  if (order.status === "CANCELLED" || isParkedStatus(order.status)) {
    return {
      currentStatus: order.status === "CANCELLED" ? "Order Requires Support" : "Order Processing",
      timeline: entries,
      notice:
        "This order requires support assistance. Please contact support@usvitalcertificates.org.",
      lastUpdatedAt: updatedAt,
    };
  }

  return {
    currentStatus: entries.at(-1)?.label ?? "Order Received",
    timeline: entries,
    notice:
      order.status === "SUBMITTED"
        ? "Government-agency processing and certificate delivery times may vary."
        : undefined,
    lastUpdatedAt: updatedAt,
  };
}

export const STAFF_STATUS_TIMELINE_KEYS = {
  IN_REVIEW: "processingAt",
  TO_CS: "processingAt",
  GTG: "processingAt",
  SUBMITTED: "submittedToAgencyAt",
} as const;

export const STAFF_STATUS_TRANSITIONS = {
  PAID: "IN_REVIEW",
  IN_REVIEW: "SUBMITTED",
} as const;

/**
 * CS-lane transitions. Fulfillment sends a broken form To CS (note required);
 * only CS/ADMIN may mark it GTG; fulfillment then resumes via IN_REVIEW.
 * TO_CS → IN_REVIEW and GTG → SUBMITTED are intentionally absent.
 */
export const STAFF_PARK_TRANSITIONS = {
  IN_REVIEW: ["TO_CS"],
  TO_CS: ["GTG"],
  GTG: ["IN_REVIEW"],
} as const;

export function isAllowedStaffStatusTransition(current: string, next: string): boolean {
  if (STAFF_STATUS_TRANSITIONS[current as keyof typeof STAFF_STATUS_TRANSITIONS] === next)
    return true;
  const parked = STAFF_PARK_TRANSITIONS[current as keyof typeof STAFF_PARK_TRANSITIONS];
  return Array.isArray(parked) && (parked as readonly string[]).includes(next);
}

/** Sending To CS never advances the customer timeline and requires an internal note. */
export function isExceptionStatus(status: string): boolean {
  return status === "TO_CS";
}

/** Internal parked states (never leak detail to public tracking). */
export function isParkedStatus(status: string): boolean {
  return status === "TO_CS" || status === "GTG";
}

/**
 * Queue sort weight for attention-first ordering: parked-for-CS first,
 * then rush, then everything else (oldest wins within each band).
 * Mirrored in the staff queue aggregation pipeline — keep the two in sync.
 */
export function attentionPriority(status: string, rush: boolean): number {
  if (isParkedStatus(status)) return 0;
  if (rush) return 1;
  return 2;
}
