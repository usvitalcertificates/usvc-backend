import assert from "node:assert/strict";
import test from "node:test";
import { env } from "../config/env.js";
import { matchesPayment, type PaymentNotice, type PaymentOrder } from "./payment-state.js";

const order: PaymentOrder = {
  _id: "507f1f77bcf86cd799439011",
  amountCents: 14900,
  currency: "usd",
  paymentStatus: "PENDING",
  stripePaymentIntentId: "pi_current",
  paymentAttempt: {
    id: "attempt_current",
    kind: "DIRECT",
    state: "CONFIRMING",
    startedAt: new Date(),
  },
};
const notice: PaymentNotice = {
  orderId: String(order._id),
  intentId: "pi_current",
  attemptId: "attempt_current",
  amountCents: 14900,
  currency: "usd",
  livemode: env.PAYMENT_ENVIRONMENT === "live",
  outcome: "PAID",
  occurredAt: new Date(),
};

test("payment ownership requires the saved provider reference and current attempt", () => {
  assert.equal(matchesPayment(order, notice), true);
  for (const patch of [
    { intentId: "pi_old" },
    { attemptId: "old" },
    { attemptId: undefined },
    { orderId: "507f1f77bcf86cd799439012" },
    { amountCents: 1 },
    { currency: "eur" },
    { livemode: !notice.livemode },
  ]) {
    assert.equal(matchesPayment(order, { ...notice, ...patch }), false, JSON.stringify(patch));
  }
});

test("Checkout payments must match their persisted session and any saved intent", () => {
  const checkoutOrder = {
    ...order,
    stripeCheckoutSessionId: "cs_current",
    paymentAttempt: { ...order.paymentAttempt!, kind: "CHECKOUT" },
  };
  assert.equal(matchesPayment(checkoutOrder, notice), false);
  assert.equal(matchesPayment(checkoutOrder, { ...notice, sessionId: "cs_current" }), true);
  assert.equal(matchesPayment(checkoutOrder, { ...notice, sessionId: "cs_old" }), false);
  assert.equal(
    matchesPayment(checkoutOrder, { ...notice, sessionId: "cs_current", intentId: "pi_wrong" }),
    false,
  );
});

test("metadata without a saved Stripe reference cannot settle a legacy order", () => {
  const legacy = { ...order, paymentAttempt: undefined, stripePaymentIntentId: undefined };
  assert.equal(matchesPayment(legacy, notice), false);
  assert.equal(matchesPayment({ ...legacy, stripePaymentIntentId: "pi_current" }, notice), true);
});
