import assert from "node:assert/strict";
import test from "node:test";
import { buildPaidOrderChatMessage } from "./google-chat.js";

test("builds the paid-order Space message with number, name, and portal link", () => {
  const message = buildPaidOrderChatMessage(
    { publicNumber: "USTX-BT-20260315-00A001", customerName: "Arfat Sayyed", orderIdHex: "abc123" },
    "https://flow.usvitalcertificates.org/",
  );
  assert.equal(
    message.text,
    "🇺🇸 New paid order: USTX-BT-20260315-00A001\n" +
      "Customer: Arfat Sayyed\n" +
      "<https://flow.usvitalcertificates.org/staff/abc123|Open in Flow Portal →>",
  );
});

test("falls back to a placeholder name and never carries sensitive fields", () => {
  const message = buildPaidOrderChatMessage(
    { publicNumber: "USCA-BT-1", customerName: "   ", orderIdHex: "abc" },
    "https://flow.example.org",
  );
  assert.ok(message.text.includes("Unknown customer"));
  assert.ok(!message.text.includes("@"));
});
