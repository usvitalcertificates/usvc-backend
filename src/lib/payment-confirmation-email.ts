import { customerEmailLayout, emailButton } from "./customer-email-layout.js";
import { FIRST_COPY_CENTS, ADDITIONAL_COPY_CENTS, COPY_DISCOUNT_CENTS } from "./orders.js";
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
  year?: number,
): { subject: string; html: string; text: string } {
  const subject = `Order confirmed - ${order.publicNumber}`;
  const certificate = `${order.stateName} ${certificateName(order.certificate)} Certificate`;
  const copies = `${order.copies} certified ${order.copies === 1 ? "copy" : "copies"}`;
  const discounted =
    order.copies > 1 &&
    order.pricing.serviceCents === FIRST_COPY_CENTS + (order.copies - 1) * ADDITIONAL_COPY_CENTS;
  const discountText = discounted
    ? `First copy: ${money(FIRST_COPY_CENTS)}\nAdditional copies: ${order.copies - 1} × ${money(ADDITIONAL_COPY_CENTS)}\nYou saved: ${money((order.copies - 1) * COPY_DISCOUNT_CENTS)}\n`
    : "";
  const discountHtml = discounted
    ? `<p style="margin:0 0 10px">First copy: ${money(FIRST_COPY_CENTS)}<br>Additional copies: ${order.copies - 1} × ${money(ADDITIONAL_COPY_CENTS)}<br><strong style="color:#176b3d">You saved: ${money((order.copies - 1) * COPY_DISCOUNT_CENTS)}</strong></p>`
    : "";
  const trackingUrl = `${frontendUrl.replace(/\/$/, "")}/track-order`;
  const rushHtml = order.pricing.rushCents
    ? `<p style="margin:0 0 10px">Rush Processing: ${money(order.pricing.rushCents)}</p>`
    : "";
  const rushText = order.pricing.rushCents
    ? `Rush Processing: ${money(order.pricing.rushCents)}\n`
    : "";
  const isRush = order.pricing.rushCents > 0;
  const workflowHtml = isRush
    ? `<p style="margin:0 0 10px">Your application will be reviewed.</p>
      <p style="margin:0 0 10px">If additional information is required we'll contact you.</p>
      <p style="margin:0 0 10px">Your request will proceed through Rush channel if all the information provided meets the government criteria.</p>
      <p style="margin:0 0 16px">You can use your order number to check your order status.</p>`
    : `<p style="margin:0 0 10px">Your application will be reviewed.</p>
      <p style="margin:0 0 10px">If additional information is needed, we'll contact you.</p>
      <p style="margin:0 0 10px">Your request will proceed through the applicable processing workflow.</p>
      <p style="margin:0 0 16px">You can use your order number to check your order status.</p>`;
  const workflowText = isRush
    ? `Your application will be reviewed.\nIf additional information is required we'll contact you.\nYour request will proceed through Rush channel if all the information provided meets the government criteria.\nYou can use your order number to check your order status.`
    : `Your application will be reviewed.\nIf additional information is needed, we'll contact you.\nYour request will proceed through the applicable processing workflow.\nYou can use your order number to check your order status.`;

  const html = customerEmailLayout(
    `<div style="display:none;max-height:0;overflow:hidden">Your US Vital Certificates payment has been confirmed.</div>
      <h1 style="margin:0 0 14px;color:#3c3b6e;font-size:24px;line-height:1.25">Thank-you for your order</h1>
      <p style="margin:0 0 10px">Your request has been received successfully.</p>
      <div style="padding:16px;background:#f0f3fa;border:1px solid #dfe5f0;border-radius:6px"><p style="margin:0"><strong>Order Number:</strong> ${escapeHtml(order.publicNumber)}</p>
      <p style="margin:0"><strong>Certificate:</strong> ${escapeHtml(certificate)}</p>
      <p style="margin:0"><strong>Number of Copies:</strong> ${escapeHtml(copies)}</p></div>

      <h2 style="margin:26px 0 12px;color:#3c3b6e;font-size:19px">Payment</h2>
      <p style="margin:0 0 10px">Online Processing Fee: ${money(order.pricing.serviceCents)}</p>
      ${discountHtml}
      ${rushHtml}
      <p style="margin:0"><strong>Amount Paid Today: ${money(order.pricing.totalCents)}</strong></p>

      <h2 style="margin:26px 0 12px;color:#3c3b6e;font-size:19px">What Happens Next</h2>
      ${workflowHtml}
      ${emailButton(trackingUrl, "Track My Order")}
      <p style="margin:0;color:#333333;font-size:14px">State and agency fees are handled separately from your online processing payment. USVC is an independent service and is not a government agency.</p>
    `,
    frontendUrl,
    year,
  );

  const text = `Thank-you for your order

Your request has been received successfully.

Order Number: ${order.publicNumber}
Certificate: ${certificate}
Number of Copies: ${copies}

Payment
Online Processing Fee: ${money(order.pricing.serviceCents)}
${discountText}${rushText}Amount Paid Today: ${money(order.pricing.totalCents)}

What Happens Next
${workflowText}

Track My Order: ${trackingUrl}

State and agency fees are handled separately from your online processing payment. USVC is an independent service and is not a government agency.`;

  return { subject, html, text };
}
