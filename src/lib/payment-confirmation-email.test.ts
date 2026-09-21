import assert from "node:assert/strict";
import test from "node:test";
import { renderPaymentConfirmationEmail } from "./payment-confirmation-email.js";

test("renders the standard payment confirmation without sensitive details", () => {
  const email = renderPaymentConfirmationEmail(
    {
      publicNumber: "USVC-08242026-000009",
      stateName: "California",
      certificate: "BIRTH",
      copies: 1,
      pricing: { serviceCents: 12500, rushCents: 0, totalCents: 12500 },
    },
    "https://usvitalcertificates.org/",
  );

  assert.equal(email.subject, "Order confirmed — USVC-08242026-000009");
  assert.match(email.html, /California Birth Certificate/);
  assert.match(email.html, /1 certified copy/);
  assert.match(email.html, /Online Processing Fee: \$125\.00/);
  assert.doesNotMatch(email.html, /Rush Processing/);
  assert.match(email.html, /https:\/\/usvitalcertificates\.org\/track-order/);
  assert.match(email.text, /Amount Paid Today: \$125\.00/);
  for (const sensitiveLabel of ["SSN", "date of birth", "card number", "security code"])
    assert.doesNotMatch(`${email.html}${email.text}`, new RegExp(sensitiveLabel, "i"));
});

test("renders rush processing, plural copies, and escapes dynamic HTML", () => {
  const email = renderPaymentConfirmationEmail(
    {
      publicNumber: "USVC-<unsafe>",
      stateName: "A&B",
      certificate: "MARRIAGE",
      copies: 2,
      pricing: { serviceCents: 25000, rushCents: 3000, totalCents: 28000 },
    },
    "https://staging.usvitalcertificates.org",
  );

  assert.match(email.html, /USVC-&lt;unsafe&gt;/);
  assert.match(email.html, /A&amp;B Marriage Certificate/);
  assert.match(email.html, /2 certified copies/);
  assert.match(email.html, /Rush Processing: \$30\.00/);
  assert.match(email.html, /Amount Paid Today: \$280\.00/);
  assert.doesNotMatch(email.html, /USVC-<unsafe>/);
  assert.match(email.text, /Rush Processing: \$30\.00/);
});
