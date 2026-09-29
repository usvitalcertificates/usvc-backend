import assert from "node:assert/strict";
import test from "node:test";
import { computeCardLast4, isPurgeEligible, startOfToday } from "./card-purge.js";

test("derives the last 4 digits from a card number", () => {
  assert.equal(computeCardLast4("4111 1111 1111 1111"), "1111");
  assert.equal(computeCardLast4("5500-0000-0000-0004"), "0004");
  assert.equal(computeCardLast4("123"), "");
  assert.equal(computeCardLast4(""), "");
});

test("computes the start of the current day", () => {
  const cutoff = startOfToday(new Date("2026-09-29T15:30:00"));
  assert.equal(cutoff.getHours(), 0);
  assert.equal(cutoff.getMinutes(), 0);
  assert.equal(cutoff.getDate(), 29);
});

test("flags submitted orders filed before today as purge-eligible", () => {
  const now = new Date("2026-09-29T04:00:00");
  const cutoff = startOfToday(now);
  assert.equal(isPurgeEligible("SUBMITTED", new Date("2026-09-28T10:00:00"), cutoff), true);
  assert.equal(isPurgeEligible("SUBMITTED", new Date("2026-09-29T02:00:00"), cutoff), false);
  assert.equal(isPurgeEligible("IN_REVIEW", new Date("2026-09-20T10:00:00"), cutoff), false);
  assert.equal(isPurgeEligible("SUBMITTED", undefined, cutoff), false);
});
