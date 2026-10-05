export interface ChatOrderNotice {
  publicNumber: string;
  customerName: string;
  orderIdHex: string;
}

/** Builds the Space message. Fixed shape: flag header with the public order
 *  number, customer name, and a deep link into the flow portal order detail.
 *  No email, phone, SSN, or card data ever enters this payload. */
export function buildPaidOrderChatMessage(
  notice: ChatOrderNotice,
  staffPortalUrl: string,
): {
  text: string;
} {
  const name = notice.customerName.trim() || "Unknown customer";
  const portal = staffPortalUrl.replace(/\/+$/, "");
  const link = `${portal}/staff/${notice.orderIdHex}`;
  return {
    text:
      `🇺🇸 New paid order: ${notice.publicNumber}\n` +
      `Customer: ${name}\n` +
      `<${link}|Open in Flow Portal →>`,
  };
}
