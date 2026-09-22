import assert from "node:assert/strict";
import test from "node:test";
import { ORDER_TYPE_CODES, orderNumber, priceOrder } from "./orders.js";
// Two-fee model: processing fee only ($125/copy + $30 rush). No bundle.
test("prices a domestic rush order", () => assert.equal(priceOrder(2, true, false), 28000));
test("prices an international order same as domestic", () =>
  assert.equal(priceOrder(1, false, true), 12500));
test("prices twenty copies", () => assert.equal(priceOrder(20, false, false), 250000));

test("uses the preferred certificate type codes in generated order numbers", () => {
  assert.deepEqual(ORDER_TYPE_CODES, {
    BIRTH: "BT",
    DEATH: "DT",
    MARRIAGE: "MG",
    DIVORCE: "DV",
  });
  for (const [certificate, code] of Object.entries(ORDER_TYPE_CODES)) {
    assert.match(
      orderNumber(certificate as keyof typeof ORDER_TYPE_CODES),
      new RegExp(`^USVC-${code}-\\d{8}-[0-9A-F]{6}$`),
    );
  }
});
