import "dotenv/config";
import { z } from "zod";
const schema = z.object({
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
});
export const env = schema.parse(process.env);
