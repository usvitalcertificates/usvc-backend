import { customerEmailLayout, emailButton, escapeEmailHtml } from "./customer-email-layout.js";

export function renderRecoveryEmail(
  template: "RECOVERY_LINK" | "RECOVERY_CODE",
  value: string,
  frontendUrl: string,
  year?: number,
) {
  if (template === "RECOVERY_LINK")
    return {
      subject: "Resume your saved USVC application",
      text: `Continue your saved application: ${value}\nThis link expires in 48 hours. You will verify your email before viewing any details. If you did not request this, ignore this email.`,
      html: customerEmailLayout(
        `<p style="margin:0 0 16px">Continue your saved application.</p>${emailButton(value, "Resume application")}<p style="margin:0">This link expires in 48 hours. Verify your email before viewing application details. If you did not request this, ignore this email.</p>`,
        frontendUrl,
        year,
      ),
    };
  const text = `Your application verification code is ${value}. It expires in 10 minutes. Never share this code. If you did not request this, ignore this email.`;
  return {
    subject: "Your USVC verification code",
    text,
    html: customerEmailLayout(
      `<p style="margin:0 0 16px">Your application verification code is <strong style="display:inline-block;margin:8px 0;padding:8px 12px;background:#f0f3fa;border:1px solid #dfe5f0;border-radius:6px;color:#3c3b6e;font-size:28px;line-height:36px;letter-spacing:4px;text-align:center">${escapeEmailHtml(value)}</strong>. It expires in 10 minutes. Never share this code. If you did not request this, ignore this email.</p>`,
      frontendUrl,
      year,
    ),
  };
}
