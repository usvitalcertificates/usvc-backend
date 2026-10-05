import "dotenv/config";
import { z } from "zod";
export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().default(4000),
    MONGODB_URI: z.string().startsWith("mongodb"),
    MONGODB_DB_NAME: z.string().min(1).default("usvc"),
    FRONTEND_URL: z.string().url(),
    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_REFRESH_SECRET: z.string().min(32),
    STRIPE_SECRET_KEY: z.string().startsWith("sk_"),
    STRIPE_WEBHOOK_SECRET: z.string().startsWith("whsec_"),
    STRIPE_PUBLISHABLE_KEY: z.string().startsWith("pk_"),
    /** Fail-safe payment mode. "live" requires live keys; anything else
     *  requires test keys. Never infer from NODE_ENV (staging runs test
     *  keys under production builds). */
    PAYMENT_ENVIRONMENT: z.enum(["test", "live"]).default("test"),
    SENSITIVE_ENCRYPTION_KEY: z
      .string()
      .min(32)
      .refine((raw) => {
        const value = raw.trim();
        if (/^[0-9a-fA-F]{64}$/.test(value)) return true;
        try {
          return Buffer.from(value, "base64").length === 32;
        } catch {
          return false;
        }
      }, "SENSITIVE_ENCRYPTION_KEY must be 64-char hex or base64 decoding to 32 bytes"),
    SENSITIVE_KEY_ID: z.string().min(1).default("v1"),
    EMAIL_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    RESEND_API_KEY: z.string().startsWith("re_").optional(),
    EMAIL_FROM: z.string().min(1).optional(),
    EMAIL_REPLY_TO: z.string().email().optional(),
    EMAIL_RECIPIENT_OVERRIDE: z.string().email().optional(),
    /** Origin of the staff portal for invitation links, e.g. https://flow.usvitalcertificates.org */
    STAFF_PORTAL_URL: z.string().url().optional(),
    ANALYTICS_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    GA_MEASUREMENT_ID: z
      .string()
      .regex(/^G-[A-Z0-9]+$/)
      .optional(),
    GA4_MEASUREMENT_PROTOCOL_API_SECRET: z.string().min(1).optional(),
    OPENAI_CONVERSIONS_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    OPENAI_ADS_PIXEL_ID: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    OPENAI_CONVERSIONS_API_KEY: z.string().min(1).optional(),
    OPENAI_CONVERSION_SOURCE_URL: z.string().url().optional(),
    /** Incoming webhook URL of the Google Chat space receiving paid-order
     *  alerts. Unset disables the worker; the URL is never committed. */
    GOOGLE_CHAT_WEBHOOK_URL: z.string().url().optional(),
    CARD_PURGE_HOUR: z.coerce.number().int().min(0).max(23).default(4),
  })
  .superRefine((value, context) => {
    if (value.EMAIL_ENABLED) {
      for (const key of ["RESEND_API_KEY", "EMAIL_FROM", "EMAIL_REPLY_TO"] as const) {
        if (!value[key])
          context.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required when EMAIL_ENABLED=true`,
          });
      }
      if (!value.STAFF_PORTAL_URL)
        context.addIssue({
          code: "custom",
          path: ["STAFF_PORTAL_URL"],
          message: "STAFF_PORTAL_URL is required when EMAIL_ENABLED=true",
        });
    }
    if (
      value.ANALYTICS_ENABLED &&
      (!value.GA_MEASUREMENT_ID || !value.GA4_MEASUREMENT_PROTOCOL_API_SECRET)
    ) {
      context.addIssue({
        code: "custom",
        path: ["GA_MEASUREMENT_ID"],
        message:
          "GA_MEASUREMENT_ID and GA4_MEASUREMENT_PROTOCOL_API_SECRET are required when ANALYTICS_ENABLED=true",
      });
    }
    if (
      value.OPENAI_CONVERSIONS_ENABLED &&
      (!value.OPENAI_ADS_PIXEL_ID ||
        !value.OPENAI_CONVERSIONS_API_KEY ||
        !value.OPENAI_CONVERSION_SOURCE_URL)
    ) {
      context.addIssue({
        code: "custom",
        path: ["OPENAI_ADS_PIXEL_ID"],
        message:
          "OPENAI_ADS_PIXEL_ID, OPENAI_CONVERSIONS_API_KEY, and OPENAI_CONVERSION_SOURCE_URL are required when OPENAI_CONVERSIONS_ENABLED=true",
      });
    }
    // Livemode assertion: test keys can never charge real money and live keys
    // must never run outside the live payment environment.
    const liveSecret = value.STRIPE_SECRET_KEY.startsWith("sk_live_");
    const livePublishable = value.STRIPE_PUBLISHABLE_KEY.startsWith("pk_live_");
    if (value.PAYMENT_ENVIRONMENT === "live" && (!liveSecret || !livePublishable)) {
      context.addIssue({
        code: "custom",
        path: ["PAYMENT_ENVIRONMENT"],
        message: "PAYMENT_ENVIRONMENT=live requires sk_live_ and pk_live_ Stripe keys",
      });
    }
    if (value.PAYMENT_ENVIRONMENT === "test" && (liveSecret || livePublishable)) {
      context.addIssue({
        code: "custom",
        path: ["PAYMENT_ENVIRONMENT"],
        message: "Live Stripe keys require PAYMENT_ENVIRONMENT=live",
      });
    }
  });
export const env = envSchema.parse(process.env);
