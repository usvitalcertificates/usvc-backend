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
