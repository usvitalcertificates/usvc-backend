import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { env } from "./config/env.js";
import { errors } from "./middleware/errors.js";
import { authRouter } from "./routes/auth.js";
import { contactRouter } from "./routes/contact.js";
import { ordersRouter } from "./routes/orders.js";
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
app.use("/webhooks", express.raw({ type: "application/json" }), webhookRouter);
app.use(express.json({ limit: "100kb" }));
app.use(
  rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: true, legacyHeaders: false }),
);
app.use("/auth", authRouter);
app.use("/contact-messages", contactRouter);
app.use("/orders", ordersRouter);
app.use(errors);
