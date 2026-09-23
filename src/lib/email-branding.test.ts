import assert from "node:assert/strict";
import test from "node:test";
import { EMAIL_LOGO_URL, emailLogoHeader } from "./email-branding.js";

test("email logo is the lightweight email-sized asset over absolute https", () => {
  assert.match(EMAIL_LOGO_URL, /^https:\/\/www\.usvitalcertificates\.org\/assets\//);
  assert.ok(
    EMAIL_LOGO_URL.endsWith("usvc-logo-email.png"),
    "emails must use the small email-sized logo, not the full-resolution asset",
  );
});

test("email logo header renders a fixed-size image with alt text", () => {
  const header = emailLogoHeader();
  assert.ok(header.includes(`src="${EMAIL_LOGO_URL}"`));
  assert.ok(header.includes('alt="US Vital Certificates logo"'));
  assert.ok(header.includes('width="92"'));
});
