export const EMAIL_LOGO_URL = "https://www.usvitalcertificates.org/assets/usvc-logo.png";

export function emailLogoHeader(): string {
  return `<header style="margin:0 0 24px;text-align:center"><img src="${EMAIL_LOGO_URL}" alt="US Vital Certificates logo" width="92" height="92" style="display:inline-block;width:92px;height:92px;border:0;outline:none;text-decoration:none" /></header>`;
}
