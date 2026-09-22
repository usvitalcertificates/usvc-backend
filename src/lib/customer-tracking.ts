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

  if (order.status === "CANCELLED") {
    return {
      currentStatus: "Order Requires Support",
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
  SUBMITTED: "submittedToAgencyAt",
} as const;

export const STAFF_STATUS_TRANSITIONS = {
  PAID: "IN_REVIEW",
  IN_REVIEW: "SUBMITTED",
} as const;

export function isAllowedStaffStatusTransition(current: string, next: string): boolean {
  return STAFF_STATUS_TRANSITIONS[current as keyof typeof STAFF_STATUS_TRANSITIONS] === next;
}
