function escapeHtml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ??
      character,
  );
}

/** Staff-portal setup link. Pure helper so tests can pin the contract. */
export function buildStaffSetupUrl(portalOrigin: string, setupToken: string): string {
  return `${portalOrigin.replace(/\/$/, "")}/auth?setup=${encodeURIComponent(setupToken)}`;
}

export function renderStaffInvitationEmail(input: { fullName: string; setupUrl: string }) {
  const name = input.fullName.trim() || "there";
  return {
    subject: "You're invited to the USVC Fulfillment Center",
    html: `<!doctype html><html lang="en"><body style="font-family:'Times New Roman',Times,serif;color:#000"><main style="max-width:620px;margin:auto;padding:32px"><h1 style="color:#3c3b6e">You've been invited, ${escapeHtml(name)}</h1><p>A USVC super-admin invited you to the internal Fulfillment Center. This portal is for authorized staff only.</p><p><strong>To activate your account:</strong></p><ol><li>Open your personal setup link below within <strong>48 hours</strong>.</li><li>Create your own password (12+ characters, known only to you).</li><li>Pair your own authenticator app (Google or Microsoft Authenticator) and confirm a 6-digit code.</li></ol><p><a href="${escapeHtml(input.setupUrl)}">Set up my staff account</a></p><p style="color:#555;font-size:13px">If the button doesn't work, paste this link into your browser:<br>${escapeHtml(input.setupUrl)}</p><p style="color:#555;font-size:13px">Didn't expect this invitation? Contact the USVC super-admin — only they can issue or withdraw invitations.</p></main></body></html>`,
    text: `You've been invited, ${name}\n\nA USVC super-admin invited you to the internal Fulfillment Center (authorized staff only).\n\nTo activate your account:\n1. Open your personal setup link below within 48 hours.\n2. Create your own password (12+ characters, known only to you).\n3. Pair your own authenticator app (Google or Microsoft Authenticator) and confirm a 6-digit code.\n\nSet up my staff account:\n${input.setupUrl}\n\nDidn't expect this invitation? Contact the USVC super-admin.`,
  };
}
