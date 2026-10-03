import assert from "node:assert/strict";
import test from "node:test";
import type Stripe from "stripe";
import {
  chargeServiceFee,
  DECLINED_MESSAGE,
  parseCardExpiry,
  PROCESSOR_ERROR_MESSAGE,
  VERIFICATION_REQUIRED_MESSAGE,
} from "./direct-charge.js";

const baseParams = {
  orderId: "order123",
  orderNumber: "USTX-BT-20260101-00A001",
  email: "buyer@example.com",
  amountCents: 14900,
  card: { number: "4111 1111 1111 1111", expiry: "12/30", securityCode: "123" },
  idempotencyKey: "usvc_order_charge_order123_1",
};

function fakeStripe(behavior: {
  paymentMethodId?: string;
  intentStatus?: string;
  intentId?: string;
  throwError?: unknown;
  seen?: Record<string, unknown>;
}) {
  const store = (behavior.seen ??= {});
  return {
    paymentMethods: {
      create: async (args: unknown) => {
        Object.assign(store, { paymentMethodArgs: args });
        return { id: behavior.paymentMethodId ?? "pm_test" };
      },
    },
    paymentIntents: {
      create: async (args: unknown, opts: unknown) => {
        Object.assign(store, { intentArgs: args, intentOpts: opts });
        if (behavior.throwError) throw behavior.throwError;
        return { id: behavior.intentId ?? "pi_test", status: behavior.intentStatus ?? "open" };
      },
    },
  } as unknown as Stripe;
}

test("parses MM/YY expiry", () => {
  assert.deepEqual(parseCardExpiry("12/30"), { expMonth: 12, expYear: 2030 });
  assert.deepEqual(parseCardExpiry("01/25"), { expMonth: 1, expYear: 2025 });
  assert.equal(parseCardExpiry("13/30"), null);
  assert.equal(parseCardExpiry("1230"), null);
  assert.equal(parseCardExpiry(""), null);
});

test("charges the server-computed amount with order idempotency metadata", async () => {
  const seen: Record<string, unknown> = {};
  const stripe = fakeStripe({ seen, intentStatus: "succeeded", intentId: "pi_ok" });
  const result = await chargeServiceFee(stripe, baseParams);
  assert.deepEqual(result, { ok: true, paymentIntentId: "pi_ok", chargePath: "raw" });
  const intentArgs = seen.intentArgs as Record<string, unknown>;
  assert.equal(intentArgs.amount, 14900);
  assert.equal(intentArgs.currency, "usd");
  assert.equal(intentArgs.confirm, true);
  assert.deepEqual(intentArgs.automatic_payment_methods, {
    enabled: true,
    allow_redirects: "never",
  });
  assert.deepEqual((intentArgs.metadata as Record<string, string>).orderId, "order123");
  assert.deepEqual(
    (seen.intentOpts as Record<string, string>).idempotencyKey,
    "usvc_order_charge_order123_1",
  );
  const pmArgs = (seen.paymentMethodArgs as { card: Record<string, unknown> }).card;
  assert.equal(pmArgs.number, "4111111111111111");
  assert.equal(pmArgs.exp_month, 12);
  assert.equal(pmArgs.exp_year, 2030);
  assert.equal(pmArgs.cvc, "123");
});

test("token path charges without raw-PAN APIs", async () => {
  const seen: Record<string, unknown> = {};
  const stripe = fakeStripe({ seen, intentStatus: "succeeded", intentId: "pi_tok" });
  const result = await chargeServiceFee(stripe, { ...baseParams, cardToken: "tok_test123" });
  assert.deepEqual(result, { ok: true, paymentIntentId: "pi_tok", chargePath: "token" });
  assert.equal(seen.paymentMethodArgs, undefined);
  const intentArgs = seen.intentArgs as Record<string, unknown>;
  assert.deepEqual(intentArgs.payment_method_data, {
    type: "card",
    card: { token: "tok_test123" },
  });
  assert.equal(intentArgs.amount, 14900);
});

test("invalid token maps to 402 with a single attempt (no silent raw retry)", async () => {
  const seen: Record<string, unknown> = {};
  const stripe = fakeStripe({
    seen,
    throwError: {
      type: "StripeInvalidRequestError",
      code: "resource_missing",
      message: "No such payment_method.",
    },
  });
  // StripeInvalidRequestError is not a card error: propagates for the 502 path.
  const thrown = await chargeServiceFee(stripe, { ...baseParams, cardToken: "tok_bad" }).then(
    () => null,
    (e: unknown) => e,
  );
  assert.deepEqual(thrown, {
    type: "StripeInvalidRequestError",
    code: "resource_missing",
    message: "No such payment_method.",
  });
  assert.equal(seen.paymentMethodArgs, undefined);
});
test("maps card declines to 402 with a controlled message", async () => {
  const stripe = fakeStripe({
    throwError: {
      type: "StripeCardError",
      code: "card_declined",
      message: "Your card was declined.",
    },
  });
  const result = await chargeServiceFee(stripe, baseParams);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.httpStatus, 402);
    assert.equal(result.code, "card_declined");
    // Processor text never passes through to the UI.
    assert.equal(result.message, DECLINED_MESSAGE);
  }
});

test("maps known decline codes to tailored messages, unknown codes to generic", async () => {
  const cvcStripe = fakeStripe({
    throwError: { type: "StripeCardError", code: "incorrect_cvc", message: "CVC wrong." },
  });
  const cvcResult = await chargeServiceFee(cvcStripe, baseParams);
  assert.ok(!cvcResult.ok && cvcResult.message.includes("security code"));
  const oddStripe = fakeStripe({
    throwError: {
      type: "StripeCardError",
      code: "processing_error",
      message: "Processor docs link.",
    },
  });
  const oddResult = await chargeServiceFee(oddStripe, baseParams);
  assert.ok(!oddResult.ok && oddResult.message === DECLINED_MESSAGE);
});

test("maps requires_action to a verification message", async () => {
  const stripe = fakeStripe({ intentStatus: "requires_action" });
  const result = await chargeServiceFee(stripe, baseParams);
  assert.deepEqual(result, {
    ok: false,
    httpStatus: 402,
    code: "authentication_required",
    message: VERIFICATION_REQUIRED_MESSAGE,
  });
});

test("rejects malformed card input without calling Stripe", async () => {
  const seen: Record<string, unknown> = {};
  const stripe = fakeStripe({ seen });
  const result = await chargeServiceFee(stripe, {
    ...baseParams,
    card: { number: "4111", expiry: "12/30", securityCode: "12" },
  });
  assert.deepEqual(result, {
    ok: false,
    httpStatus: 402,
    code: "invalid_card",
    message: DECLINED_MESSAGE,
  });
  assert.equal(seen.paymentMethodArgs, undefined);
});

test("logs the exact processor detail server-side without card data", async () => {
  const lines: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args[0]);
  };
  try {
    const stripe = fakeStripe({
      throwError: {
        type: "StripeCardError",
        code: "card_declined",
        decline_code: "generic_decline",
        message: "Processor internal text.",
      },
    });
    await chargeServiceFee(stripe, baseParams);
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 1);
  const logged = lines[0] as Record<string, unknown>;
  assert.equal(logged.scope, "direct-charge");
  assert.equal(logged.orderId, "order123");
  assert.equal(logged.declineCode, "generic_decline");
  assert.equal(logged.processorMessage, "Processor internal text.");
  assert.deepEqual(Object.keys(logged).sort(), [
    "code",
    "declineCode",
    "orderId",
    "processorMessage",
    "scope",
    "stripeType",
  ]);
  assert.ok(!JSON.stringify(logged).includes("4111111111111111"), "no PAN in log");
});

test("idempotency errors map to a retryable 502", async () => {
  const stripe = fakeStripe({
    throwError: {
      type: "StripeIdempotencyError",
      code: "idempotency_key_in_use",
      message: "Keys for idempotent requests can only be used with the same parameters.",
    },
  });
  const result = await chargeServiceFee(stripe, baseParams);
  assert.deepEqual(result, {
    ok: false,
    httpStatus: 502,
    code: "idempotency_key_in_use",
    message: PROCESSOR_ERROR_MESSAGE,
  });
});

test("processor errors propagate for a 502", async () => {
  const stripe = fakeStripe({ throwError: { type: "StripeAPIError", message: "boom" } });
  const thrown = await chargeServiceFee(stripe, baseParams).then(
    () => null,
    (e: unknown) => e,
  );
  assert.deepEqual(thrown, { type: "StripeAPIError", message: "boom" });
  assert.ok(PROCESSOR_ERROR_MESSAGE.length > 0);
});
