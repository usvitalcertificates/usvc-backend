import assert from "node:assert/strict";
import test from "node:test";
import { buildStaffSetupUrl, renderStaffInvitationEmail } from "./staff-email.js";

test("setup URL points at the staff portal auth page with the token", () => {
  assert.equal(
    buildStaffSetupUrl("https://flow.usvitalcertificates.org/", "abc123"),
    "https://flow.usvitalcertificates.org/auth?setup=abc123",
  );
});

test("invitation email contains the link without personalization header", () => {
  const email = renderStaffInvitationEmail({
    setupUrl: "https://flow.example/auth?setup=t",
  });
  assert.match(email.subject, /invited/i);
  assert.ok(email.html.includes("https://flow.example/auth?setup=t"));
  assert.ok(!email.html.includes("<h1"));
  assert.ok(!email.html.includes("You've been invited"));
  assert.ok(!email.html.includes("authorized staff only"));
  assert.ok(email.html.includes("A USVC Admin invited you to the internal Fulfillment Center."));
  assert.ok(email.html.includes("48 hours"));
  assert.ok(!email.html.includes("<img")); // no remote images: inbox-safe by construction
  assert.ok(email.text.includes("https://flow.example/auth?setup=t"));
  assert.ok(!email.text.includes("You've been invited"));
});

test("invitation dispatch sends current jobs and drops stale ones without contact data", async () => {
  const { resolveStaffInvitation } = await import("./staff-email.js");
  const { newInviteToken } = await import("./staff-auth.js");
  const { token, tokenHash } = newInviteToken();
  const { token: otherToken } = newInviteToken();

  const send = resolveStaffInvitation(
    { inviteTokenHash: tokenHash },
    token,
    "https://flow.example",
  );
  assert.ok(!("drop" in send) && send.email.html.includes("/auth?setup="));

  // Re-sent invite rotates the hash: older job drops quietly.
  assert.deepEqual(
    resolveStaffInvitation({ inviteTokenHash: tokenHash }, otherToken, "https://flow.example"),
    { drop: true },
  );
  // Missing token or missing account also drops (never throws, never needs contact data).
  assert.deepEqual(
    resolveStaffInvitation({ inviteTokenHash: tokenHash }, undefined, "https://flow.example"),
    { drop: true },
  );
  assert.deepEqual(resolveStaffInvitation(null, token, "https://flow.example"), { drop: true });
});
