/**
 * Email-sized logo (256px, ~46KB). The full 1254px asset is too heavy for
 * Gmail's image proxy first-fetch; oversized images are a common cause of
 * permanently broken images in already-delivered messages (the proxy caches
 * per-message results). Keep this file small; it renders at 92px.
 */
export const EMAIL_LOGO_URL = "https://www.usvitalcertificates.org/assets/usvc-logo-email.png";

export function emailLogoHeader(): string {
  return `<header style="margin:0 0 24px;text-align:center"><img src="${EMAIL_LOGO_URL}" alt="US Vital Certificates logo" width="92" height="92" style="display:inline-block;width:92px;height:92px;border:0;outline:none;text-decoration:none" /></header>`;
}
