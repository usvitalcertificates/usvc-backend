import assert from "node:assert/strict";
import test from "node:test";
import { priceOrder } from "./orders.js";
// Two-fee model: processing fee only ($125/copy + $30 rush). No bundle.
test("prices a domestic rush order", () => assert.equal(priceOrder(2, true, false), 28000));
test("prices an international order same as domestic", () =>
  assert.equal(priceOrder(1, false, true), 12500));
test("prices twenty copies", () => assert.equal(priceOrder(20, false, false), 250000));
