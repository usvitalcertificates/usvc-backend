import assert from "node:assert/strict";
import test from "node:test";
import { env } from "../config/env.js";
import { GoogleChatDelivery } from "../models/google-chat-delivery.js";
import { queuePaidOrderChatNotice } from "./google-chat-outbox.js";

const order = {
  _id: "order-test",
  publicNumber: "USNY-BT-20261023-TEST01",
  applicant: { firstName: "Sample", lastName: "Applicant" },
  stateName: "New York",
  certificate: "BIRTH",
  deviceLocation: { city: "Albany", region: "New York" },
  addresses: { shipping: { city: "Albany", state: "NY" } },
  amountCents: 14900,
  rush: false,
};
const webhook = "https://chat.googleapis.com/v1/spaces/test/messages?key=synthetic&token=synthetic";

test("paid-order Chat notices queue only for live production payments", async (t) => {
  const queued = t.mock.method(GoogleChatDelivery, "updateOne", async () => ({
    upsertedCount: 1,
  }));
  const originalMode = env.PAYMENT_ENVIRONMENT;
  const originalWebhook = env.GOOGLE_CHAT_WEBHOOK_URL;
  try {
    env.PAYMENT_ENVIRONMENT = "test";
    env.GOOGLE_CHAT_WEBHOOK_URL = webhook;
    await queuePaidOrderChatNotice(order);
    assert.equal(queued.mock.callCount(), 0, "staging/test payments must not queue");

    env.PAYMENT_ENVIRONMENT = "live";
    env.GOOGLE_CHAT_WEBHOOK_URL = undefined;
    await queuePaidOrderChatNotice(order);
    assert.equal(queued.mock.callCount(), 0, "live mode without a webhook must not queue");

    env.GOOGLE_CHAT_WEBHOOK_URL = webhook;
    await queuePaidOrderChatNotice(order);
    assert.equal(queued.mock.callCount(), 1, "live production payments queue once");
  } finally {
    env.PAYMENT_ENVIRONMENT = originalMode;
    env.GOOGLE_CHAT_WEBHOOK_URL = originalWebhook;
    queued.mock.restore();
  }
});
