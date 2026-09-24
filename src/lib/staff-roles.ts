/** Canonical staff roles. `STAFF` is legacy (migrated to `FULFILLMENT` on deploy). */
export type StaffRole = "ADMIN" | "FULFILLMENT" | "CS";

export const STAFF_ROLES: StaffRole[] = ["ADMIN", "FULFILLMENT", "CS"];

/** Pricing (`Products` card) is visible only to ADMIN + CS. */
export function canSeePricing(role: string | undefined | null): boolean {
  return role === "ADMIN" || role === "CS";
}

/** Form correction without ownership is limited to ADMIN + CS. */
export function canCorrectOrders(role: string | undefined | null): boolean {
  return role === "ADMIN" || role === "CS";
}

export function isAdminRole(role: string | undefined | null): boolean {
  return role === "ADMIN";
}
