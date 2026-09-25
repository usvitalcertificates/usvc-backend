import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { staffStatusUpdateSchema, TO_CS_SUBSTATUSES } from "./order-substatus.js";

describe("To-CS substatus validation", () => {
  test("accepts To CS with a note and a listed substatus", () => {
    const parsed = staffStatusUpdateSchema.parse({
      status: "TO_CS",
      note: "Billing mismatch",
      substatus: "1st Contact - Billing Issues",
    });
    assert.equal(parsed.substatus, "1st Contact - Billing Issues");
  });

  test("keeps substatus optional for To CS", () => {
    const parsed = staffStatusUpdateSchema.parse({ status: "TO_CS", note: "Needs review" });
    assert.equal(parsed.substatus, undefined);
  });

  test("excludes 2nd and 3rd Contact from the list", () => {
    assert.ok(!TO_CS_SUBSTATUSES.includes("2nd Contact"));
    assert.ok(!TO_CS_SUBSTATUSES.includes("3rd Contact"));
    assert.throws(() =>
      staffStatusUpdateSchema.parse({ status: "TO_CS", note: "x", substatus: "2nd Contact" }),
    );
  });

  test("rejects unknown substatus values", () => {
    assert.throws(() =>
      staffStatusUpdateSchema.parse({ status: "TO_CS", note: "x", substatus: "Nope" }),
    );
  });

  test("rejects a substatus on any move other than To CS", () => {
    for (const status of ["IN_REVIEW", "GTG", "SUBMITTED"] as const) {
      assert.throws(
        () => staffStatusUpdateSchema.parse({ status, substatus: "Dead" }),
        /Substatus is only supported when sending To CS/,
      );
    }
  });

  test("still enforces the note length rule", () => {
    assert.throws(() => staffStatusUpdateSchema.parse({ status: "TO_CS", note: "  " }));
  });
});
