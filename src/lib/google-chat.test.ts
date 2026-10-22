import assert from "node:assert/strict";
import test from "node:test";
import { buildPaidOrderChatMessage } from "./google-chat.js";

test("builds the exact 6-line paid-order template", () => {
  const message = buildPaidOrderChatMessage({
    publicNumber: "USR-OR-BT-20261005-01195",
    customerName: "Steve Bruno",
    stateName: "Oregon",
    certificate: "BIRTH",
    deviceCity: "Washington",
    deviceRegion: "District of Columbia",
    shipCity: "Tualatin",
    shipState: "Oregon",
    amountCents: 14900,
    rush: false,
  });
  assert.equal(
    message.text,
    "*New Paid Order*\n" +
      "Order USR-OR-BT-20261005-01195, STEVE BRUNO\n" +
      "Oregon, Birth Certificate\n" +
      "Amount: $149.00\n" +
      "Device Location: Washington, District of Columbia\n" +
      "Shipping Address: Tualatin, Oregon",
  );
});

test("marks rush orders in the bold heading", () => {
  const message = buildPaidOrderChatMessage({
    publicNumber: "USR-OR-BT-20261005-01195",
    customerName: "Steve Bruno",
    stateName: "Oregon",
    certificate: "BIRTH",
    deviceCity: "Washington",
    deviceRegion: "District of Columbia",
    shipCity: "Tualatin",
    shipState: "Oregon",
    amountCents: 14900,
    rush: true,
  });
  const lines = message.text.split("\n");
  assert.equal(lines.length, 6);
  assert.equal(lines[0], "*New Paid Order - RUSH*");
});

test("falls back to Unknown parts and never carries sensitive fields", () => {
  const message = buildPaidOrderChatMessage({
    publicNumber: "USCA-BT-1",
    customerName: "   ",
    stateName: "",
    certificate: "BIRTH",
    deviceCity: "",
    deviceRegion: "",
    shipCity: "",
    shipState: "",
    amountCents: 14900,
    rush: false,
  });
  assert.equal(
    message.text,
    "*New Paid Order*\n" +
      "Order USCA-BT-1, Unknown customer\n" +
      "Unknown, Birth Certificate\n" +
      "Amount: $149.00\n" +
      "Device Location: Unknown\n" +
      "Shipping Address: Unknown",
  );
  assert.ok(!message.text.includes("@"));
});

test("handles partial locations without shifting the shape", () => {
  const message = buildPaidOrderChatMessage({
    publicNumber: "USCA-BT-1",
    customerName: "Jane Doe",
    stateName: "California",
    certificate: "DIVORCE",
    deviceCity: "",
    deviceRegion: "Texas",
    shipCity: "Austin",
    shipState: "",
    amountCents: 70900,
    rush: false,
  });
  const lines = message.text.split("\n");
  assert.equal(lines.length, 6);
  assert.equal(lines[3], "Amount: $709.00");
  assert.ok(lines[4]?.includes("Device Location: Texas"));
  assert.ok(lines[5]?.includes("Shipping Address: Austin"));
});

test("marks legacy deliveries without an amount as Unknown", () => {
  const message = buildPaidOrderChatMessage({
    publicNumber: "USCA-BT-1",
    customerName: "Jane Doe",
    stateName: "California",
    certificate: "BIRTH",
    deviceCity: "",
    deviceRegion: "",
    shipCity: "",
    shipState: "",
    rush: false,
  });
  assert.match(message.text, /^Amount: Unknown$/m);
});
