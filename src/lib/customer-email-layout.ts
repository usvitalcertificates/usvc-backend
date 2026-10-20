export function escapeEmailHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** Presentation tables and inline styles intentionally avoid client-specific CSS dependencies. */
export function customerEmailLayout(
  content: string,
  frontendUrl: string,
  year = new Date().getUTCFullYear(),
): string {
  const origin = new URL(frontendUrl).origin;
  const support = escapeEmailHtml(`${origin}/contact`);
  const website = escapeEmailHtml(origin);
  const websiteAddress = escapeEmailHtml(new URL(origin).hostname);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"></head><body style="margin:0;padding:0;background:#f3f5f8;color:#303449;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:24px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f3f5f8"><tr><td align="center" style="padding:24px 12px"><!--[if mso]><table role="presentation" width="600"><tr><td><![endif]--><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;background:#ffffff;border:1px solid #e1e5ed;border-radius:8px;table-layout:fixed"><tr><td style="padding:22px 24px;border-top:4px solid #b22234;border-bottom:1px solid #e1e5ed;color:#3c3b6e;font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:bold;line-height:28px">US Vital Certificates</td></tr><tr><td style="padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:24px;overflow-wrap:anywhere;word-break:break-word">${content}</td></tr><tr><td style="padding:20px 24px;background:#f8f9fc;border-top:1px solid #e1e5ed;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:#5a6072"><strong style="color:#3c3b6e">USVC Customer Support</strong><br><a href="${support}" style="color:#3c3b6e;text-decoration:underline">Contact customer support</a><br><a href="${website}" style="color:#3c3b6e;text-decoration:underline">${websiteAddress}</a><br><span style="color:#5a6072">© ${year} US Vital Certificates</span></td></tr></table><!--[if mso]></td></tr></table><![endif]--></td></tr></table></body></html>`;
}

export function emailButton(url: string, label: string): string {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0"><tr><td bgcolor="#b22234" style="border-radius:6px;text-align:center"><a href="${escapeEmailHtml(url)}" style="display:inline-block;padding:12px 20px;border:1px solid #b22234;border-radius:6px;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:24px;font-weight:bold;text-decoration:none">${escapeEmailHtml(label)}</a></td></tr></table>`;
}
