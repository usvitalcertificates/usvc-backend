/**
 * Assignment scoping for the fulfillment queue. Every role (ADMIN, CS,
 * FULFILLMENT) sees all paid orders by default — rows stay masked for
 * non-owners and actions stay gated — while the explicit `assigned` filter
 * narrows to mine/unassigned.
 */
export function queueAssignmentMatch(
  assigned: "mine" | "unassigned" | "all",
  userSub: string,
): Record<string, unknown> {
  if (assigned === "mine") return { assignedTo: userSub };
  if (assigned === "unassigned") return { assignedTo: null };
  return {};
}

type QueueAuditEvent = {
  action?: string;
  metadata?: { status?: string };
  createdAt?: Date | string;
};

/** Returns the latest explicit fulfillment-to-CS handoff timestamp. */
export function latestSentToCsAt(events: QueueAuditEvent[] | undefined): Date | undefined {
  let sentAt: Date | undefined;
  for (const event of events ?? []) {
    if (event.action !== "fulfillment_status_updated" || event.metadata?.status !== "TO_CS")
      continue;
    const timestamp = event.createdAt ? new Date(event.createdAt) : undefined;
    if (timestamp && !Number.isNaN(timestamp.getTime())) sentAt = timestamp;
  }
  return sentAt;
}
