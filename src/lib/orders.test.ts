import assert from "node:assert/strict";
import test from "node:test";
import { ORDER_TYPE_CODES, encodeSequence, orderNumber, priceOrder } from "./orders.js";
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
      orderNumber(certificate as keyof typeof ORDER_TYPE_CODES, "CA", 1000),
      new RegExp(`^USCA-${code}-\\d{8}-00B001$`),
    );
  }
});

test("prefixes the order number with US plus the state code", () => {
  assert.match(orderNumber("DEATH", "tx", 1), /^USTX-DT-\d{8}-00A001$/);
  assert.match(orderNumber("MARRIAGE", "NY", 25975), /^USNY-MG-\d{8}-01A001$/);
});

test("encodes plate-style sequential suffixes", () => {
  const cases: Array<[number, string]> = [
    [1, "00A001"],
    [2, "00A002"],
    [999, "00A999"],
    [1000, "00B001"],
    [25974, "00Z999"],
    [25975, "01A001"],
    [51948, "01Z999"],
    [51949, "02A001"],
  ];
  for (const [sequence, suffix] of cases) assert.equal(encodeSequence(sequence), suffix);
  assert.throws(() => encodeSequence(0), /positive integer/);
  assert.throws(() => encodeSequence(-5), /positive integer/);
  assert.throws(() => encodeSequence(1.5), /positive integer/);
  assert.throws(() => encodeSequence(2597401), /exhausted/);
});
