export type ContactEmailMessage = {
  fullName: string;
  email: string;
  orderNumber: string;
  message: string;
  sensitiveContentWarning: boolean;
};

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ??
      character,
  );
}

function orderReference(message: ContactEmailMessage): string {
  return message.orderNumber
    ? `Order number: ${message.orderNumber}`
    : "No order number was provided.";
}

export function renderContactSupportEmail(message: ContactEmailMessage) {
  const subject = `New contact inquiry — ${message.fullName}`;
  const warning = message.sensitiveContentWarning
    ? '<p style="color:#b22234"><strong>Warning:</strong> This message may contain sensitive information.</p>'
    : "";
  return {
    subject,
    html: `<!doctype html><html lang="en"><body style="font-family:'Times New Roman',Times,serif;color:#000"><main style="max-width:620px;margin:auto;padding:32px"><h1 style="color:#3c3b6e">New contact inquiry</h1><p><strong>Name:</strong> ${escapeHtml(message.fullName)}</p><p><strong>Email:</strong> ${escapeHtml(message.email)}</p><p><strong>${escapeHtml(orderReference(message))}</strong></p>${warning}<h2 style="color:#3c3b6e">Message</h2><p style="white-space:pre-wrap">${escapeHtml(message.message)}</p></main></body></html>`,
    text: `New contact inquiry\n\nName: ${message.fullName}\nEmail: ${message.email}\n${orderReference(message)}\n${message.sensitiveContentWarning ? "WARNING: This message may contain sensitive information.\n" : ""}\nMessage:\n${message.message}`,
  };
}

export function renderContactCustomerReceipt(message: ContactEmailMessage) {
  const reference = orderReference(message);
  return {
    subject: "We received your message — US Vital Certificates",
    html: `<!doctype html><html lang="en"><body style="font-family:'Times New Roman',Times,serif;color:#000"><main style="max-width:620px;margin:auto;padding:32px"><h1 style="color:#3c3b6e">Thank you for contacting US Vital Certificates</h1><p>We received your message and a USVC representative will reply within one business day.</p><p><strong>${escapeHtml(reference)}</strong></p><p>Please do not send payment card numbers or Social Security numbers by email.</p><p style="color:#555;font-size:13px">USVC is an independent service and is not a government agency.</p></main></body></html>`,
    text: `Thank you for contacting US Vital Certificates\n\nWe received your message and a USVC representative will reply within one business day.\n\n${reference}\n\nPlease do not send payment card numbers or Social Security numbers by email.\n\nUSVC is an independent service and is not a government agency.`,
  };
}
