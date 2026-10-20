import test from "node:test";
import assert from "node:assert/strict";
import { renderPaymentRecoveryEmail } from "./payment-recovery-email.js";
test("approved recovery email escapes values and places the secure CTA before order details", () => {
  const email = renderPaymentRecoveryEmail(
    {
      firstName: '<Jane & "Example">',
      publicNumber: "ORDER<123>",
      stateName: "Florida",
      certificate: "BIRTH",
      url: "https://example.test/resume#private-token",
    },
    "https://example.test/",
  );
  assert.equal(email.subject, "Your payment wasn’t completed — resume your application");
  assert.match(email.html, /&lt;Jane &amp; &quot;Example&quot;&gt;/);
  assert.doesNotMatch(email.html, /<Jane|ORDER<123>/);
  for (const body of [email.html, email.text]) {
    assert.match(body, /Florida Birth Certificate/);
    assert.match(body, /48 hours/);
    assert.match(body, /verify your email before showing your saved application/);
    assert.match(body, /USVC Customer Support/);
    assert.ok(body.indexOf("Resume your application") < body.indexOf("Order ID:"));
    assert.match(body, /https:\/\/example.test\/resume#private-token/);
    assert.doesNotMatch(body, /7 days|SSN|card number|security code/);
  }
});
