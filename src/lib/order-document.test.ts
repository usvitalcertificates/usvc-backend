import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { ORDER_DOCUMENT_MAX_BYTES, validateOrderDocument } from "./order-document.js";

const pdf = (size: number): Buffer => {
  const buffer = Buffer.alloc(size, 0x41);
  buffer.write("%PDF-1.7", 0, "binary");
  return buffer;
};

describe("completion PDF validation", () => {
  test("accepts a small valid PDF and keeps a safe name", () => {
    const result = validateOrderDocument({
      buffer: pdf(1024),
      size: 1024,
      mimetype: "application/pdf",
      originalname: "completion.pdf",
    });
    assert.deepEqual(result, { name: "completion.pdf", size: 1024 });
  });

  test("rejects a missing or empty file", () => {
    assert.throws(() => validateOrderDocument({}), /A PDF file is required/);
    assert.throws(
      () => validateOrderDocument({ buffer: Buffer.alloc(0), size: 0 }),
      /A PDF file is required/,
    );
  });

  test("rejects non-PDF content and mimetypes", () => {
    assert.throws(
      () =>
        validateOrderDocument({
          buffer: Buffer.from("hello world, not a pdf"),
          size: 22,
          mimetype: "application/pdf",
        }),
      /not a valid PDF/,
    );
    assert.throws(
      () =>
        validateOrderDocument({
          buffer: pdf(64),
          size: 64,
          mimetype: "image/png",
        }),
      /Only PDF files/,
    );
  });

  test("rejects files over 10 MB", () => {
    assert.throws(
      () =>
        validateOrderDocument({
          buffer: pdf(64),
          size: ORDER_DOCUMENT_MAX_BYTES + 1,
          mimetype: "application/pdf",
        }),
      /10 MB or smaller/,
    );
  });
});
