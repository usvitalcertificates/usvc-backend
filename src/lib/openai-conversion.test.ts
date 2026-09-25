import assert from "node:assert/strict";
import test from "node:test";
import { buildOpenAIConversionPayload } from "./openai-conversion.js";

test("builds a privacy-safe, attributable OpenAI order conversion", () => {
  const payload = buildOpenAIConversionPayload(
    {
      eventId: "857b17bb-22d6-49fd-86b5-74b51af16488",
      occurredAt: new Date("2026-09-25T10:00:00.000Z"),
      amountCents: 15500,
      currency: "usd",
      certificate: "BIRTH",
      copies: 1,
      oppref: "opaque-click-reference",
      obref: "opaque-browser-reference",
    },
    "https://usvitalcertificates.org/order/confirmation",
  );
  assert.deepEqual(payload, {
    validate_only: false,
    events: [
      {
        id: "857b17bb-22d6-49fd-86b5-74b51af16488",
        type: "order_created",
        timestamp_ms: 1790330400000,
        oppref: "opaque-click-reference",
        source_url: "https://usvitalcertificates.org/order/confirmation",
        action_source: "web",
        user: { obref: "opaque-browser-reference" },
        data: {
          type: "contents",
          amount: 15500,
          currency: "USD",
          contents: [
            {
              id: "usvc-birth",
              name: "Birth Certificate",
              content_type: "product",
              quantity: 1,
            },
          ],
        },
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(payload), /email|phone|address|stripe|card|publicNumber/i);
});

test("omits absent OpenAI attribution values", () => {
  const event = buildOpenAIConversionPayload(
    {
      eventId: "event-1",
      occurredAt: new Date(0),
      amountCents: 12500,
      currency: "USD",
      certificate: "DEATH",
      copies: 2,
    },
    "https://usvitalcertificates.org/order/confirmation",
  ).events[0];
  assert.ok(!("oppref" in event));
  assert.ok(!("user" in event));
});
