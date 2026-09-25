export type SubmissionNotificationOrder = {
  publicNumber: string;
  stateName: string;
  certificate: "BIRTH" | "DEATH" | "MARRIAGE" | "DIVORCE";
  copies: number;
  rush: boolean;
  requestorFirstName: string;
  submittedAt: Date;
};

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ??
      character,
  );
}

function certificateName(value: SubmissionNotificationOrder["certificate"]): string {
  return `${value.charAt(0)}${value.slice(1).toLowerCase()}`;
}

function submittedDate(value: Date): string {
  return value.toLocaleString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function renderSubmissionNotificationEmail(
  order: SubmissionNotificationOrder,
  _frontendUrl: string,
) {
  const subject = `Your order has been submitted — ${order.publicNumber}`;
  const certificate = `${order.stateName} ${certificateName(order.certificate)} Certificate`;
  const copies = `${order.copies} certified ${order.copies === 1 ? "copy" : "copies"}${order.rush ? " (Rush)" : ""}`;
  const greeting = order.requestorFirstName ? `Hi ${order.requestorFirstName},` : "Hello,";

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#ffffff;color:#000000;font-family:'Times New Roman',Times,serif;font-size:16px;line-height:1.5">
    <div style="display:none;max-height:0;overflow:hidden">Your US Vital Certificates order was submitted to the government agency on ${escapeHtml(submittedDate(order.submittedAt))}.</div>
    <main style="max-width:620px;margin:0 auto;padding:40px 24px">
      <h1 style="margin:0 0 14px;color:#3c3b6e;font-size:24px;line-height:1.25">Your order is on its way to the agency</h1>
      <p style="margin:0 0 10px">${escapeHtml(greeting)}</p>
      <p style="margin:0 0 16px">Good news — we submitted your application to the government agency on <strong>${escapeHtml(submittedDate(order.submittedAt))}</strong>. Here are your order details for your records:</p>
      <table style="width:100%;border-collapse:collapse;margin:0 0 16px">
        <tr><td style="padding:6px 0;color:#555">Order number</td><td style="padding:6px 0"><strong>${escapeHtml(order.publicNumber)}</strong></td></tr>
        <tr><td style="padding:6px 0;color:#555">Certificate</td><td style="padding:6px 0">${escapeHtml(certificate)}</td></tr>
        <tr><td style="padding:6px 0;color:#555">Copies</td><td style="padding:6px 0">${escapeHtml(copies)}</td></tr>
        <tr><td style="padding:6px 0;color:#555">Submitted</td><td style="padding:6px 0">${escapeHtml(submittedDate(order.submittedAt))}</td></tr>
      </table>
      <h2 style="margin:0 0 10px;color:#3c3b6e;font-size:19px">What happens next</h2>
      <p style="margin:0 0 10px">The agency now processes your application. Processing and delivery times vary by state to state — no action is needed from you.</p>
      <p style="margin:0 0 10px">If anything else is required, we will contact you at this email address.</p>
    </main>
  </body>
</html>`;

  const text = `Your order is on its way to the agency\n\n${greeting}\n\nGood news — we submitted your application to the government agency on ${submittedDate(order.submittedAt)}. Here are your order details for your records:\n\nOrder number: ${order.publicNumber}\nCertificate: ${certificate}\nCopies: ${copies}\nSubmitted: ${submittedDate(order.submittedAt)}\n\nWhat happens next\n\nThe agency now processes your application. Processing and delivery times vary by state to state — no action is needed from you.\n\nIf anything else is required, we will contact you at this email address.`;

  return { subject, html, text };
}
