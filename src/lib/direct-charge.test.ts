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
  assert.deepEqual(result, { ok: true, paymentIntentId: "pi_ok" });
  const intentArgs = seen.intentArgs as Record<string, unknown>;
  assert.equal(intentArgs.amount, 14900);
  assert.equal(intentArgs.currency, "usd");
  assert.equal(intentArgs.confirm, true);
  assert.deepEqual((intentArgs.metadata as Record<string, string>).orderId, "order123");
  assert.deepEqual(
    (seen.intentOpts as Record<string, string>).idempotencyKey,
    "usvc_order_charge_order123",
  );
  const pmArgs = (seen.paymentMethodArgs as { card: Record<string, unknown> }).card;
  assert.equal(pmArgs.number, "4111111111111111");
  assert.equal(pmArgs.exp_month, 12);
  assert.equal(pmArgs.exp_year, 2030);
  assert.equal(pmArgs.cvc, "123");
});

test("maps card declines to 402 with a field error", async () => {
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
    assert.equal(result.message, "Your card was declined.");
  }
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

test("processor errors propagate for a 502", async () => {
  const stripe = fakeStripe({ throwError: { type: "StripeAPIError", message: "boom" } });
  const thrown = await chargeServiceFee(stripe, baseParams).then(
    () => null,
    (e: unknown) => e,
  );
  assert.deepEqual(thrown, { type: "StripeAPIError", message: "boom" });
  assert.ok(PROCESSOR_ERROR_MESSAGE.length > 0);
});
