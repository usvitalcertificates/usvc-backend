import { z } from "zod";

/**
 * ADMIN-only status correction. The normal workflow is forward-only; this map
 * is the single place a super-admin may deliberately rewind an accidental move
 * (for example a premature "Submit to Govt Agency"). Every move requires a
 * reason and is written to the order audit trail.
 */
export const ADMIN_REOPEN_TARGETS = ["PAID", "IN_REVIEW"] as const;

export type AdminReopenTarget = (typeof ADMIN_REOPEN_TARGETS)[number];

export const ADMIN_REOPEN_TRANSITIONS = {
  SUBMITTED: ["IN_REVIEW", "PAID"],
  IN_REVIEW: ["PAID"],
  TO_CS: ["IN_REVIEW", "PAID"],
  GTG: ["IN_REVIEW", "PAID"],
} as const;

export function isAllowedAdminReopen(current: string, next: string): boolean {
  const allowed = ADMIN_REOPEN_TRANSITIONS[current as keyof typeof ADMIN_REOPEN_TRANSITIONS];
  return Array.isArray(allowed) && (allowed as readonly string[]).includes(next);
}

export const adminReopenSchema = z.object({
  status: z.enum(ADMIN_REOPEN_TARGETS),
  reason: z.string().trim().min(1).max(500),
});

export type AdminReopenInput = z.infer<typeof adminReopenSchema>;
