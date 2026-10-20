import { zohoWebhookRouter } from "./routes/zoho-webhook.js";
import { recoveryRouter } from "./routes/recovery.js";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { env } from "./config/env.js";
import { errors } from "./middleware/errors.js";
import { authRouter } from "./routes/auth.js";
import { adminRouter } from "./routes/admin.js";
import { contactRouter } from "./routes/contact.js";
import { ordersRouter } from "./routes/orders.js";
import { unpaidOrdersRouter } from "./routes/unpaid-orders.js";
import { staffPaymentsRouter } from "./routes/staff-payments.js";
import { staffRouter } from "./routes/staff.js";
import { webhookRouter } from "./routes/webhooks.js";
export const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((req, res, next) => {
  req.id = randomUUID();
  res.setHeader("x-request-id", req.id);
  next();
});
app.use(helmet());
app.use(cors({ origin: env.FRONTEND_URL, credentials: true }));
app.get("/health", (req, res) => res.json({ status: "ok", service: "usvc-api" }));
app.use(
  "/webhooks/zoho",
  express.raw({ type: "application/x-www-form-urlencoded", limit: "100kb" }),
  zohoWebhookRouter,
);
app.use("/webhooks", express.raw({ type: "application/json" }), webhookRouter);
app.use(express.json({ limit: "100kb" }));
app.use("/auth", authRouter);
app.use("/admin", adminRouter);
app.use("/staff/unpaid-orders", unpaidOrdersRouter);
app.use("/staff/payments", staffPaymentsRouter);
app.use("/staff", staffRouter);
app.use("/contact-messages", contactRouter);
app.use("/recovery", recoveryRouter);
app.use("/orders", ordersRouter);
app.use(errors);
