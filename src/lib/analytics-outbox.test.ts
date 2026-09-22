import assert from "node:assert/strict";
import test from "node:test";
import { analyticsRetryDelayMs, buildPurchasePayload } from "./analytics-purchase.js";

test("builds a privacy-safe GA4 purchase payload with accurate items", () => {
  const payload = buildPurchasePayload({
    transactionId: "USVC-BT-20260922-ABC123",
    amountCents: 28000,
    serviceCents: 25000,
    rushCents: 3000,
    currency: "usd",
    certificate: "BIRTH",
    copies: 2,
    rush: true,
  });

  assert.equal(payload.events[0]?.name, "purchase");
  assert.deepEqual(payload.events[0]?.params.items, [
    {
      item_id: "usvc-birth",
      item_name: "Birth Certificate",
      item_category: "USVC Processing",
      quantity: 2,
      price: 125,
    },
    {
      item_id: "usvc-rush-processing",
      item_name: "Rush Processing",
      item_category: "USVC Processing",
      quantity: 1,
      price: 30,
    },
  ]);
  assert.equal(payload.events[0]?.params.transaction_id, "USVC-BT-20260922-ABC123");
  assert.equal(payload.events[0]?.params.value, 280);
  assert.equal(payload.events[0]?.params.currency, "USD");
  assert.doesNotMatch(JSON.stringify(payload), /email|phone|ssn|address|stripe|card/i);
});

test("caps GA4 retry delays at one hour", () => {
  assert.equal(analyticsRetryDelayMs(1), 5_000);
  assert.equal(analyticsRetryDelayMs(20), 3_600_000);
});
