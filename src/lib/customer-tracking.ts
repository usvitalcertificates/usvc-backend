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

  if (order.status === "CANCELLED" || order.status === "ON_HOLD" || order.status === "NEED_INFO") {
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
  ON_HOLD: "processingAt",
  NEED_INFO: "processingAt",
  SUBMITTED: "submittedToAgencyAt",
} as const;

export const STAFF_STATUS_TRANSITIONS = {
  PAID: "IN_REVIEW",
  IN_REVIEW: "SUBMITTED",
} as const;

/** Operational exceptions: agents park an order with an internal note, then resume. */
export const STAFF_EXCEPTION_TRANSITIONS = {
  IN_REVIEW: ["ON_HOLD", "NEED_INFO"],
  ON_HOLD: ["IN_REVIEW"],
  NEED_INFO: ["IN_REVIEW"],
} as const;

export function isAllowedStaffStatusTransition(current: string, next: string): boolean {
  if (STAFF_STATUS_TRANSITIONS[current as keyof typeof STAFF_STATUS_TRANSITIONS] === next)
    return true;
  const exceptions =
    STAFF_EXCEPTION_TRANSITIONS[current as keyof typeof STAFF_EXCEPTION_TRANSITIONS];
  return Array.isArray(exceptions) && (exceptions as readonly string[]).includes(next);
}

/** Exceptions never advance the customer timeline; they require an internal note. */
export function isExceptionStatus(status: string): boolean {
  return status === "ON_HOLD" || status === "NEED_INFO";
}
