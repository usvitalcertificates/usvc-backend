import "dotenv/config";
import { z } from "zod";
const schema = z
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
    EMAIL_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    RESEND_API_KEY: z.string().startsWith("re_").optional(),
    EMAIL_FROM: z.string().min(1).optional(),
    EMAIL_REPLY_TO: z.string().email().optional(),
    EMAIL_RECIPIENT_OVERRIDE: z.string().email().optional(),
  })
  .superRefine((value, context) => {
    if (!value.EMAIL_ENABLED) return;
    for (const key of ["RESEND_API_KEY", "EMAIL_FROM", "EMAIL_REPLY_TO"] as const) {
      if (!value[key])
        context.addIssue({
          code: "custom",
          path: [key],
          message: `${key} is required when EMAIL_ENABLED=true`,
        });
    }
  });
export const env = schema.parse(process.env);
