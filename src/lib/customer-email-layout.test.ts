import test from "node:test";
import assert from "node:assert/strict";
import { renderPaymentRecoveryEmail } from "./payment-recovery-email.js";
import { renderPaymentConfirmationEmail } from "./payment-confirmation-email.js";
import { renderSubmissionNotificationEmail } from "./submission-notification-email.js";
import { renderContactCustomerReceipt, renderContactSupportEmail } from "./contact-email.js";
import { renderRecoveryEmail } from "./recovery-email.js";
import { recoveryUrl } from "./recovery-url.js";
const origin = "https://example.test";
const reference = "USDC-BT-20261020-00A123";
const url = `${origin}/resume-district-of-columbia-birth-certificate#synthetic-private-token`;
const order = {
  publicNumber: reference,
  stateName: "District of Columbia",
  certificate: "BIRTH" as const,
  copies: 3,
  pricing: { serviceCents: 28900, rushCents: 1200, totalCents: 30100 },
};
const contact = {
  fullName: "Jane <Example>",
  email: "jane@example.test",
  orderNumber: reference,
  message: "Private inquiry",
  sensitiveContentWarning: false,
};
const emails = [
  renderPaymentRecoveryEmail({ ...order, firstName: "Jane <Example>", url }, origin),
  renderPaymentConfirmationEmail(order, origin),
  renderSubmissionNotificationEmail(
    {
      ...order,
      rush: true,
      requestorFirstName: "Jane <Example>",
      submittedAt: new Date("2026-10-20T12:00:00Z"),
    },
    origin,
  ),
  renderContactCustomerReceipt(contact, origin),
  renderRecoveryEmail("RECOVERY_LINK", url, origin),
  renderRecoveryEmail("RECOVERY_CODE", "123456", origin),
];
test("all six customer emails use readable inline, table-based branding and safe support links", () => {
  for (const email of emails) {
    assert.match(email.html, /max-width:600px/);
    assert.match(
      email.html,
      /font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:24px/,
    );
    assert.match(email.html, /font-size:14px;line-height:22px/);
    assert.match(email.html, /role="presentation"/);
    assert.match(email.html, /https:\/\/example.test\/contact/);
    assert.match(email.html, /USVC Customer Support/);
    assert.ok(email.html.includes(`© ${new Date().getUTCFullYear()} US Vital Certificates`));
    assert.match(email.html, />example.test<\/a>/);
    assert.doesNotMatch(email.html, /<img|<script|font-size:13px|Jane <Example>/);
    assert.doesNotMatch(email.text, /Contact customer support|US Vital Certificates website/);
  }
  assert.doesNotMatch(renderContactSupportEmail(contact).html, /Contact customer support/);
});
test("recovery text, subjects, CTA order and selectable code remain unchanged", () => {
  const link = emails[4],
    code = emails[5];
  assert.equal(link.subject, "Resume your saved USVC application");
  assert.equal(
    link.text,
    `Continue your saved application: ${url}\nThis link expires in 48 hours. You will verify your email before viewing any details. If you did not request this, ignore this email.`,
  );
  assert.equal(
    code.text,
    "Your application verification code is 123456. It expires in 10 minutes. Never share this code. If you did not request this, ignore this email.",
  );
  assert.match(code.html, />123456<\/strong>/);
  assert.ok(
    emails[0].html.indexOf("Resume your application") < emails[0].html.indexOf("Order ID:"),
  );
  assert.match(emails[0].html, /Jane &lt;Example&gt;/);
});
test("resume URLs cover all certificate types, multiword states and email-wide recovery", () => {
  for (const stateSlug of ["alabama", "new-york", "district-of-columbia"])
    for (const certificate of ["BIRTH", "DEATH", "MARRIAGE", "DIVORCE"])
      assert.equal(
        recoveryUrl(origin + "/", "opaque", { stateSlug, certificate }),
        `${origin}/resume-${stateSlug}-${certificate.toLowerCase()}-certificate#opaque`,
      );
  assert.equal(recoveryUrl(origin, "opaque"), `${origin}/resume#opaque`);
  assert.equal(
    recoveryUrl(origin, "opaque", { stateSlug: "../../bad", certificate: "BIRTH" }),
    `${origin}/resume#opaque`,
  );
  assert.equal(
    recoveryUrl(origin, "opaque", { stateSlug: "alabama", certificate: "BAD" }),
    `${origin}/resume#opaque`,
  );
});

test("footer year follows the calendar when a new email is rendered", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2027-01-01T00:00:00Z") });
  assert.match(
    renderRecoveryEmail("RECOVERY_CODE", "123456", origin, 2026).html,
    /© 2026 US Vital Certificates/,
  );
  assert.match(
    renderRecoveryEmail("RECOVERY_CODE", "123456", origin).html,
    /© 2027 US Vital Certificates/,
  );
});
