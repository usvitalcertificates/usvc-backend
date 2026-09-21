export type PaymentConfirmationEmailOrder = {
  publicNumber: string;
  stateName: string;
  certificate: "BIRTH" | "DEATH" | "MARRIAGE" | "DIVORCE";
  copies: number;
  pricing: { serviceCents: number; rushCents: number; totalCents: number };
};

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ??
      character,
  );
}

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function certificateName(value: PaymentConfirmationEmailOrder["certificate"]): string {
  return `${value.charAt(0)}${value.slice(1).toLowerCase()}`;
}

export function renderPaymentConfirmationEmail(
  order: PaymentConfirmationEmailOrder,
  frontendUrl: string,
): { subject: string; html: string; text: string } {
  const subject = `Order confirmed — ${order.publicNumber}`;
  const certificate = `${order.stateName} ${certificateName(order.certificate)} Certificate`;
  const copies = `${order.copies} certified ${order.copies === 1 ? "copy" : "copies"}`;
  const trackingUrl = `${frontendUrl.replace(/\/$/, "")}/track-order`;
  const rushHtml = order.pricing.rushCents
    ? `<p style="margin:0 0 10px">Rush Processing: ${money(order.pricing.rushCents)}</p>`
    : "";
  const rushText = order.pricing.rushCents
    ? `Rush Processing: ${money(order.pricing.rushCents)}\n`
    : "";

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#ffffff;color:#000000;font-family:'Times New Roman',Times,serif;font-size:16px;line-height:1.5">
    <div style="display:none;max-height:0;overflow:hidden">Your US Vital Certificates payment has been confirmed.</div>
    <main style="max-width:620px;margin:0 auto;padding:40px 24px">
      <h1 style="margin:0 0 14px;color:#3c3b6e;font-size:24px;line-height:1.25">Thank-you for your order</h1>
      <p style="margin:0 0 10px">Your request has been received successfully.</p>
      <p style="margin:0"><strong>Order Number:</strong> ${escapeHtml(order.publicNumber)}</p>
      <p style="margin:0"><strong>Certificate:</strong> ${escapeHtml(certificate)}</p>
      <p style="margin:0"><strong>Number of Copies:</strong> ${escapeHtml(copies)}</p>

      <h2 style="margin:26px 0 12px;color:#3c3b6e;font-size:19px">Payment</h2>
      <p style="margin:0 0 10px">Online Processing Fee: ${money(order.pricing.serviceCents)}</p>
      ${rushHtml}
      <p style="margin:0"><strong>Amount Paid Today: ${money(order.pricing.totalCents)}</strong></p>

      <h2 style="margin:26px 0 12px;color:#3c3b6e;font-size:19px">What Happens Next</h2>
      <p style="margin:0 0 10px">Your application will be reviewed for completeness.</p>
      <p style="margin:0 0 10px">If additional information is needed, we'll contact you.</p>
      <p style="margin:0 0 10px">Your request will proceed through the applicable processing workflow.</p>
      <p style="margin:0 0 16px">You can use your order number to check your order status.</p>
      <p style="margin:0 0 22px"><a href="${escapeHtml(trackingUrl)}" style="display:inline-block;border-radius:4px;background:#b22234;color:#ffffff;padding:11px 20px;font-weight:bold;text-decoration:none">Track My Order</a></p>
      <p style="margin:0;color:#333333;font-size:13px">State and agency fees are handled separately from your online processing payment. USVC is an independent service and is not a government agency.</p>
    </main>
  </body>
</html>`;

  const text = `Thank-you for your order

Your request has been received successfully.

Order Number: ${order.publicNumber}
Certificate: ${certificate}
Number of Copies: ${copies}

Payment
Online Processing Fee: ${money(order.pricing.serviceCents)}
${rushText}Amount Paid Today: ${money(order.pricing.totalCents)}

What Happens Next
Your application will be reviewed for completeness.
If additional information is needed, we'll contact you.
Your request will proceed through the applicable processing workflow.
You can use your order number to check your order status.

Track My Order: ${trackingUrl}

State and agency fees are handled separately from your online processing payment. USVC is an independent service and is not a government agency.`;

  return { subject, html, text };
}
