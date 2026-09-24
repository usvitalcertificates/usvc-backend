import { StaffUser } from "../models/staff.js";

/**
 * One-time role rename: legacy `STAFF` → `FULFILLMENT`.
 * Idempotent; safe to run on every deploy. Revokes sessions for migrated
 * accounts so old `STAFF` JWTs are refused and fresh tokens carry the new role.
 */
export async function migrateStaffRoles(): Promise<{ migrated: number }> {
  const now = new Date();
  const result = await StaffUser.updateMany(
    { role: "STAFF" },
    {
      $set: { role: "FULFILLMENT", sessionsRevokedAt: now },
      $push: {
        auditEvents: {
          actorId: "system",
          action: "role_migrated",
          metadata: { from: "STAFF", to: "FULFILLMENT" },
          createdAt: now,
        },
      },
    },
  );
  return { migrated: (result as { modifiedCount?: number }).modifiedCount ?? 0 };
}
