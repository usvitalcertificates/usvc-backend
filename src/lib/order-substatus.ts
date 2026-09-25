import { z } from "zod";

/**
 * Optional substatus picked when an order is parked To CS with its required
 * note. MILES-parity list, minus "2nd Contact" / "3rd Contact" per owner
 * decision (single-touch reasons only). The backend enum is the source of
 * truth; the staff frontend mirrors this list and the API rejects drift
 * with a 422.
 */
export const TO_CS_SUBSTATUSES = [
  "1st Contact",
  "1st Contact - Multiple Issues",
  "1st Contact - Credit Card Alignment",
  "1st Contact - Billing Issues",
  "1st Contact - Information Verification",
  "1st Contact - Texas Audit Number Verification",
  "1st Contact - Subject Name Alignment",
  "1st Contact - Maiden Name Verification",
  "1st Contact - Shipping Address Verification",
  "1st Contact – Delivery Issues",
  "Application Emailed to Client",
  "Dead",
  "CRC",
  "Chargeback",
  "Chargeback Refunded",
  "Refunds",
  "R-Refunded",
  "R-Voided",
  "R-Denied",
  "R-CERT_NOT_AVAIL",
  "Escalated",
  "Follow Up",
  "Future Order",
  "Made GTG",
  "Cancelled",
  "Completed",
] as const;

export type ToCsSubstatus = (typeof TO_CS_SUBSTATUSES)[number];

export const staffStatusUpdateSchema = z
  .object({
    status: z.enum(["IN_REVIEW", "TO_CS", "GTG", "SUBMITTED"]),
    // Required when sending an order To CS; kept internal only. Optional for GTG.
    note: z.string().trim().min(1).max(2000).optional(),
    // Optional only when sending To CS. Anything else is a 422.
    substatus: z.enum(TO_CS_SUBSTATUSES).optional(),
  })
  .refine((value) => !value.substatus || value.status === "TO_CS", {
    message: "Substatus is only supported when sending To CS.",
  });

export type StaffStatusUpdate = z.infer<typeof staffStatusUpdateSchema>;
