import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { app } from "../app.js";
import { env } from "../config/env.js";
import { EmailDispatch } from "../models/email-dispatch.js";
import { zohoEmail } from "../lib/zoho-email.js";

test("signed Zoho verification samples and unrelated references are acknowledged without database access", async (t) => {
  const previous = { ...env };
  env.ZOHO_WEBHOOK_SECRET = "s".repeat(48);
  env.ZOHO_EMAIL_AGENT_KEY = undefined;
  const writes = t.mock.method(EmailDispatch, "updateOne", () => {
    throw Error("must not access database");
  });
  const reads = t.mock.method(EmailDispatch, "findOne", () => {
    throw Error("must not access database");
  });
  const sends = t.mock.method(zohoEmail, "send", async () => {
    throw Error("must not send email");
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    for (const reference of ["customer-unique-reference-to-identify-the-mail", "", undefined]) {
      const payload = JSON.stringify({
        event_name: ["softbounce"],
        event_message: [
          {
            email_info: {
              client_reference: reference,
              email_reference: "sample-email-reference",
              is_smtp_trigger: false,
              subject: "webhook test email",
            },
            request_id: "sample-request",
          },
        ],
        mailagent_key: "sample-agent",
        webhook_request_id: "sample-event",
      });
      const signature = `ts=${Date.now()};s=${encodeURIComponent(createHmac("sha256", env.ZOHO_WEBHOOK_SECRET).update(payload).digest("base64"))};s-algorithm=HmacSHA256`;
      const response = await fetch(`http://127.0.0.1:${port}/webhooks/zoho`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "producer-signature": signature,
        },
        body: new URLSearchParams({ payload }).toString(),
      });
      assert.equal(response.status, 200, `sample reference: ${reference}`);
      assert.deepEqual(await response.json(), { received: true });
      const jsonResponse = await fetch(`http://127.0.0.1:${port}/webhooks/zoho`, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=UTF-8",
          "producer-signature": `ts=${Date.now()};s=${encodeURIComponent(createHmac("sha256", env.ZOHO_WEBHOOK_SECRET).update(payload).digest("base64"))};s-algorithm=HmacSHA256`,
        },
        body: payload,
      });
      assert.equal(jsonResponse.status, 200, `JSON sample reference: ${reference}`);
      assert.deepEqual(await jsonResponse.json(), { received: true });
    }
    assert.equal(writes.mock.callCount(), 0);
    assert.equal(reads.mock.callCount(), 0);
    assert.equal(sends.mock.callCount(), 0);
  } finally {
    Object.assign(env, previous);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
