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
  assert.match(email.subject, /submitted to the government agency/);
  assert.match(email.subject, /USCA-BT-20260922-00A001/);
  for (const needle of [
    "USCA-BT-20260922-00A001",
    "California Birth Certificate",
    "2 certified copies (Rush)",
    "Hi Jordan,",
    "September 23, 2026",
    "no action is needed",
    "https://www.usvitalcertificates.org/track-order",
  ]) {
    assert.ok(email.html.includes(needle), `html missing: ${needle}`);
    assert.ok(email.text.includes(needle), `text missing: ${needle}`);
  }
});

test("submission email escapes the requestor name and carries no secrets", () => {
  const email = renderSubmissionNotificationEmail(
    { ...order, requestorFirstName: '<script>alert("x")</script>' },
    "https://www.usvitalcertificates.org",
  );
  assert.ok(!email.html.includes("<script>"));
  for (const forbidden of ["ssnEnc", "cardNumber", "securityCode", "confidentialData"]) {
    assert.ok(!email.html.includes(forbidden));
    assert.ok(!email.text.includes(forbidden));
  }
});
