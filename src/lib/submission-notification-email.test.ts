import assert from "node:assert/strict";
import test from "node:test";
import { renderSubmissionNotificationEmail } from "./submission-notification-email.js";

const order = {
  publicNumber: "USCA-BT-20260922-00A001",
  stateName: "California",
  certificate: "BIRTH" as const,
  copies: 2,
  rush: true,
  requestorFirstName: "Jordan",
  submittedAt: new Date("2026-09-23T12:00:00.000Z"),
};

test("submission email recalls the order and explains next steps", () => {
  const email = renderSubmissionNotificationEmail(order, "https://www.usvitalcertificates.org/");
  assert.equal(email.subject, "Your order has been submitted — USCA-BT-20260922-00A001");
  for (const needle of [
    "USCA-BT-20260922-00A001",
    "California Birth Certificate",
    "2 certified copies (Rush)",
    "Hi Jordan,",
    "September 23, 2026",
    "no action is needed",
    "vary by state to state",
  ]) {
    assert.ok(email.html.includes(needle), `html missing: ${needle}`);
    assert.ok(email.text.includes(needle), `text missing: ${needle}`);
  }
  for (const removed of ["track-order", "not a government agency", "vary by agency"]) {
    assert.ok(!email.html.includes(removed), `html should not contain: ${removed}`);
    assert.ok(!email.text.includes(removed), `text should not contain: ${removed}`);
  }
});

test("submission email escapes the requestor name and carries no secrets", () => {
  const email = renderSubmissionNotificationEmail(
    { ...order, requestorFirstName: '<script>alert("x")</script>' },
    "https://www.usvitalcertificates.org",
  );
  assert.ok(!email.html.includes("<script>"));
  for (const forbidden of ["ssnEnc", "cardNumber", "securityCode", "confidentialData", "<img"]) {
    assert.ok(!email.html.includes(forbidden));
    assert.ok(!email.text.includes(forbidden));
  }
});
