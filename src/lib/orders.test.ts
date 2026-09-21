import assert from "node:assert/strict";
import test from "node:test";
import { priceOrder } from "./orders.js";
test("prices a domestic rush order", () => assert.equal(priceOrder(2, true, false), 50600));
test("prices an international order", () => assert.equal(priceOrder(1, false, true), 25800));
