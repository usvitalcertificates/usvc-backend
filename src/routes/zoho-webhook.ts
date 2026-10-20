import { Router } from "express";
import { env } from "../config/env.js";
import { applyZohoWebhook, verifyZohoWebhook } from "../lib/zoho-webhook.js";
export const zohoWebhookRouter = Router();
// Reachability verification exposes no state and never sends a message.
zohoWebhookRouter.get("/", (_req, res) => {
  res.sendStatus(200);
});
zohoWebhookRouter.post("/", async (req, res, next) => {
  // Zoho setup requires an unauthenticated POST reachability check. Acknowledge
  // unsigned requests without parsing or processing any event or touching the DB.
  if (!req.get("producer-signature")) {
    res.status(200).json({ received: false });
    return;
  }
  if (!env.ZOHO_WEBHOOK_SECRET) {
    res.sendStatus(503);
    return;
  }
  let payload: unknown;
  try {
    payload = verifyZohoWebhook(
      req.body,
      req.get("content-type") ?? "",
      req.get("producer-signature") ?? "",
      env.ZOHO_WEBHOOK_SECRET,
    );
  } catch {
    res.sendStatus(401);
    return;
  }
  try {
    await applyZohoWebhook(payload);
    res.json({ received: true });
  } catch (error) {
    next(error);
  }
});
