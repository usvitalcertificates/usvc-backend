import { customerEmailLayout } from "./customer-email-layout.js";
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
  return value.toLocaleDateString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export function renderSubmissionNotificationEmail(
  order: SubmissionNotificationOrder,
  frontendUrl: string,
  year?: number,
) {
  const subject = `Your order has been submitted - ${order.publicNumber}`;
  const certificate = `${order.stateName} ${certificateName(order.certificate)} Certificate`;
  const copies = `${order.copies} certified ${order.copies === 1 ? "copy" : "copies"}${order.rush ? " (Rush)" : ""}`;
  const greeting = order.requestorFirstName ? `Hi ${order.requestorFirstName},` : "Hello,";

  const html = customerEmailLayout(
    `<div style="display:none;max-height:0;overflow:hidden">Your US Vital Certificates order was submitted to the government agency on ${escapeHtml(submittedDate(order.submittedAt))}.</div>
      <h1 style="margin:0 0 14px;color:#3c3b6e;font-size:24px;line-height:1.25">Your order is on its way to the agency</h1>
      <p style="margin:0 0 10px">${escapeHtml(greeting)}</p>
      <p style="margin:0 0 16px">Good news. We submitted your application to the government agency on <strong>${escapeHtml(submittedDate(order.submittedAt))}</strong>. Here are your order details for your records:</p>
      <table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;table-layout:fixed;border-collapse:collapse;margin:0 0 16px;background:#f0f3fa;border:1px solid #dfe5f0">
        <tr><td style="padding:8px 10px;vertical-align:top;color:#555">Order number</td><td style="padding:8px 10px;vertical-align:top"><strong>${escapeHtml(order.publicNumber)}</strong></td></tr>
        <tr><td style="padding:8px 10px;vertical-align:top;color:#555">Certificate</td><td style="padding:8px 10px;vertical-align:top">${escapeHtml(certificate)}</td></tr>
        <tr><td style="padding:8px 10px;vertical-align:top;color:#555">Copies</td><td style="padding:8px 10px;vertical-align:top">${escapeHtml(copies)}</td></tr>
        <tr><td style="padding:8px 10px;vertical-align:top;color:#555">Submitted</td><td style="padding:8px 10px;vertical-align:top">${escapeHtml(submittedDate(order.submittedAt))}</td></tr>
      </table>
      <h2 style="margin:0 0 10px;color:#3c3b6e;font-size:19px">What happens next</h2>
      <p style="margin:0 0 10px">The agency now processes your application. Processing and delivery times vary from state to state. No action is needed from you.</p>
      <p style="margin:0 0 10px">If anything else is required, we will contact you at this email address.</p>
    `,
    frontendUrl,
    year,
  );

  const text = `Your order is on its way to the agency\n\n${greeting}\n\nGood news. We submitted your application to the government agency on ${submittedDate(order.submittedAt)}. Here are your order details for your records:\n\nOrder number: ${order.publicNumber}\nCertificate: ${certificate}\nCopies: ${copies}\nSubmitted: ${submittedDate(order.submittedAt)}\n\nWhat happens next\n\nThe agency now processes your application. Processing and delivery times vary from state to state. No action is needed from you.\n\nIf anything else is required, we will contact you at this email address.`;

  return { subject, html, text };
}
