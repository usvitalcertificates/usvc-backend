import { customerEmailLayout, emailButton } from "./customer-email-layout.js";
const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
export function renderPaymentRecoveryEmail(
  order: {
    firstName: string;
    publicNumber: string;
    stateName: string;
    certificate: string;
    url: string;
  },
  frontendUrl: string,
  year?: number,
) {
  const certificate = `${order.stateName} ${order.certificate.charAt(0).toUpperCase()}${order.certificate.slice(1).toLowerCase()} Certificate`;
  const introduction =
    "We couldn’t complete the payment for your order. Your application details are saved, so you can continue without starting again by clicking the button below.";
  const expiry =
    "This link is valid for 48 hours. If you’ve already completed payment, please ignore this email.";
  const privacy =
    "For your privacy, we’ll ask you to verify your email before showing your saved application. You can then review your details and try payment again.";
  const supportUrl = `${frontendUrl.replace(/\/$/, "")}/contact`;
  return {
    subject: "Your payment wasn’t completed — resume your application",
    text: `Hi ${order.firstName || "there"},\n\n${introduction}\n\nResume your application: ${order.url}\n\nOrder ID: ${order.publicNumber}\nCertificate Type: ${certificate}\n\n${expiry}\n\n${privacy}\n\nNeed any further help? Please contact our customer support team: ${supportUrl}\n\nThank you,\nUSVC Customer Support`,
    html: customerEmailLayout(
      `<p>Hi ${escapeHtml(order.firstName || "there")},</p><p>${introduction}</p>${emailButton(order.url, "Resume your application")}<div style="padding:16px;background:#f0f3fa;border:1px solid #dfe5f0;border-radius:6px"><p style="margin:0"><strong>Order ID:</strong> ${escapeHtml(order.publicNumber)}<br><strong>Certificate Type:</strong> ${escapeHtml(certificate)}</p></div><p>${expiry}</p><p>${privacy}</p><p>Need any further help? Please <a href="${escapeHtml(supportUrl)}" style="color:#3c3b6e;text-decoration:underline">contact our customer support team</a>.</p><p>Thank you,<br><strong>USVC Customer Support</strong></p>`,
      frontendUrl,
      year,
    ),
  };
}
