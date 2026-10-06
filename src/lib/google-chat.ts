export interface ChatOrderNotice {
  publicNumber: string;
  customerName: string;
  stateName: string;
  certificate: string;
  deviceCity: string;
  deviceRegion: string;
  shipCity: string;
  shipState: string;
  rush: boolean;
}

function certificateLabel(value: string): string {
  const labels: Record<string, string> = {
    BIRTH: "Birth Certificate",
    DEATH: "Death Certificate",
    MARRIAGE: "Marriage Certificate",
    DIVORCE: "Divorce Certificate",
  };
  return labels[value] ?? "Certificate";
}

function place(city: string, region: string): string {
  const trimmedCity = city.trim();
  const trimmedRegion = region.trim();
  if (trimmedCity && trimmedRegion) return `${trimmedCity}, ${trimmedRegion}`;
  return trimmedCity || trimmedRegion || "Unknown";
}

/** Builds the Space message in the exact fixed 5-line template (Google Chat
 *  `*bold*` markup on the heading; `- RUSH` suffix for rush orders).
 *  Customer name is uppercased; missing parts fall back to "Unknown" so the
 *  shape never shifts. No email, phone, SSN, card data, and no raw IPs,
 *  ever enter this payload. */
export function buildPaidOrderChatMessage(notice: ChatOrderNotice): {
  text: string;
} {
  const rawName = notice.customerName.trim();
  const name = rawName ? rawName.toUpperCase() : "Unknown customer";
  const state = notice.stateName.trim() || "Unknown";
  return {
    text: [
      notice.rush ? "*New Paid Order - RUSH*" : "*New Paid Order*",
      `Order ${notice.publicNumber}, ${name}`,
      `${state}, ${certificateLabel(notice.certificate)}`,
      `Device Location: ${place(notice.deviceCity, notice.deviceRegion)}`,
      `Shipping Address: ${place(notice.shipCity, notice.shipState)}`,
    ].join("\n"),
  };
}
