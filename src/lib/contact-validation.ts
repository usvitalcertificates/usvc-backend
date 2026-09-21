import { z } from "zod";

export const contactSubmissionSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(255),
  orderNumber: z.string().trim().max(80).optional().default(""),
  message: z.string().trim().min(1).max(4_000),
  antiAbuse: z.object({
    honeypot: z.string().max(200).default(""),
    formStartedAt: z.number().finite().nonnegative(),
  }),
});

const ssnPattern = /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/;
const cardPattern = /\b(?:\d[ -]?){12,18}\d\b/;

export function hasSensitiveContactContent(message: string): boolean {
  return ssnPattern.test(message) || cardPattern.test(message);
}

export function isContactSubmissionSuspicious(input: {
  honeypot: string;
  formStartedAt: number;
}): boolean {
  return input.honeypot.trim().length > 0 || Date.now() - input.formStartedAt < 2_000;
}
