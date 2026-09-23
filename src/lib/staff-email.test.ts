import assert from "node:assert/strict";
import test from "node:test";
import { buildStaffSetupUrl, renderStaffInvitationEmail } from "./staff-email.js";

test("setup URL points at the staff portal auth page with the token", () => {
  assert.equal(
    buildStaffSetupUrl("https://flow.usvitalcertificates.org/", "abc123"),
    "https://flow.usvitalcertificates.org/auth?setup=abc123",
  );
});

test("invitation email contains the link and escapes the staff name", () => {
  const email = renderStaffInvitationEmail({
    fullName: 'Amy <script>alert("x")</script>',
    setupUrl: "https://flow.example/auth?setup=t",
  });
  assert.match(email.subject, /invited/i);
  assert.ok(email.html.includes("https://flow.example/auth?setup=t"));
  assert.ok(!email.html.includes("<script>"));
  assert.ok(email.html.includes("48 hours"));
  assert.ok(email.text.includes("https://flow.example/auth?setup=t"));
});
