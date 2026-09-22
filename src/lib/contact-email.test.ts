import assert from "node:assert/strict";
import test from "node:test";
import { renderContactCustomerReceipt, renderContactSupportEmail } from "./contact-email.js";
import { EMAIL_LOGO_URL } from "./email-branding.js";

const inquiry = {
  fullName: "Jane <Applicant>",
  email: "jane@example.com",
  orderNumber: "USVC-123",
  message: "Please help with <my> order.",
  sensitiveContentWarning: true,
};

test("renders an escaped branded support notification", () => {
  const email = renderContactSupportEmail(inquiry);
  assert.equal(email.subject, "New contact inquiry — Jane <Applicant>");
  assert.match(email.html, /Jane &lt;Applicant&gt;/);
  assert.match(email.html, /Please help with &lt;my&gt; order\./);
  assert.match(email.html, /#3c3b6e/);
  assert.match(email.html, /sensitive information/);
  assert.match(email.html, new RegExp(EMAIL_LOGO_URL));
  assert.match(email.html, /alt="US Vital Certificates logo"/);
  assert.doesNotMatch(email.html, /Jane <Applicant>/);
});

test("renders a customer receipt without repeating the inquiry", () => {
  const email = renderContactCustomerReceipt(inquiry);
  assert.equal(email.subject, "We received your message — US Vital Certificates");
  assert.match(email.html, /within one business day/);
  assert.match(email.html, /USVC-123/);
  assert.match(email.html, new RegExp(EMAIL_LOGO_URL));
  assert.match(email.html, /alt="US Vital Certificates logo"/);
  assert.doesNotMatch(email.html, /Please help with/);
});
