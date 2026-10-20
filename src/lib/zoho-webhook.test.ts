import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyZohoWebhook } from "./zoho-webhook.js";
const secret = "s".repeat(32);
const payload = JSON.stringify({ value: "plus+ & unicode café", event_name: ["delivered"] });
const body = Buffer.from(new URLSearchParams({ payload }).toString());
function signature(time = Date.now(), data = payload) {
  return `ts=${time};s=${encodeURIComponent(createHmac("sha256", secret).update(data).digest("base64"))};s-algorithm=HmacSHA256`;
}
test("Zoho verifies the decoded form payload exactly, including plus signs and Unicode", () => {
  assert.deepEqual(
    verifyZohoWebhook(
      body,
      "application/x-www-form-urlencoded; charset=UTF-8",
      signature(),
      secret,
    ),
    JSON.parse(payload),
  );
});
test("Zoho verifies the raw JSON body of its verification request", () => {
  const json = JSON.stringify({
    event_name: ["email_open"],
    event_message: [
      {
        email_info: {
          client_reference: "customer-unique-reference-to-identify-the-mail",
          email_reference: "2518b.35307e20e5c556.m1.dd756374@zylker.com",
          is_smtp_trigger: false,
          subject: "webhook test email",
        },
      },
    ],
    mailagent_key: "sample-agent",
    webhook_request_id: "sample-event",
  });
  assert.deepEqual(
    verifyZohoWebhook(
      Buffer.from(json),
      "application/json; charset=UTF-8",
      signature(Date.now(), json),
      secret,
    ),
    JSON.parse(json),
  );
  assert.throws(() =>
    verifyZohoWebhook(
      Buffer.from(json),
      "application/json",
      signature(Date.now(), json + " "),
      secret,
    ),
  );
});
test("Zoho rejects tampered, unsigned, stale, future, malformed and downgraded webhooks", () => {
  for (const header of [
    "",
    signature(Date.now() - 360000),
    signature(Date.now() + 360000),
    signature().replace("HmacSHA256", "HmacSHA1"),
    signature() + ";ts=1",
    signature(Date.now(), "other"),
    "ts=abc;s=%zz;s-algorithm=HmacSHA256",
  ])
    assert.throws(() =>
      verifyZohoWebhook(body, "application/x-www-form-urlencoded", header, secret),
    );
  assert.throws(() => verifyZohoWebhook(body, "text/plain", signature(), secret));
  assert.throws(() =>
    verifyZohoWebhook(Buffer.from("  "), "application/json", signature(), secret),
  );
  assert.throws(() =>
    verifyZohoWebhook(
      Buffer.from(body.toString() + "&other=1"),
      "application/x-www-form-urlencoded",
      signature(),
      secret,
    ),
  );
});
