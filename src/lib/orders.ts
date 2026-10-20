/** Only the processing fee and optional per-order rush fee are charged now.
 * Agency and shipping fees remain separate. All amounts are integer cents. */
export const MAX_COPIES = 9;
export const FIRST_COPY_CENTS = 14900;
export const ADDITIONAL_COPY_CENTS = 7000;
export const COPY_DISCOUNT_CENTS = FIRST_COPY_CENTS - ADDITIONAL_COPY_CENTS;
export function processingPricing(copies: number, rush: boolean) {
  if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIES)
    throw new RangeError("Choose between 1 and 9 copies.");
  const serviceCents = FIRST_COPY_CENTS + (copies - 1) * ADDITIONAL_COPY_CENTS;
  const rushCents = rush ? 1200 : 0;
  return { serviceCents, rushCents, totalCents: serviceCents + rushCents };
}
export const priceOrder = (copies: number, rush: boolean, _international: boolean) =>
  processingPricing(copies, rush).totalCents;

export const ORDER_TYPE_CODES = {
  BIRTH: "BT",
  DEATH: "DT",
  MARRIAGE: "MG",
  DIVORCE: "DV",
} as const;

export type OrderCertificateType = keyof typeof ORDER_TYPE_CODES;

/** Plate-style sequential suffix: 2 digits + letter + 3 digits (1-based).
 *  1 -> 00A001, 999 -> 00A999, 1000 -> 00B001, 25974 -> 00Z999,
 *  25975 -> 01A001. Capacity 2,597,400 (through 99Z999), then it throws
 *  instead of ever duplicating. */
const SERIALS_PER_LETTER = 999;
const LETTERS = 26;
const PREFIXES = 100;
const VALUES_PER_PREFIX = SERIALS_PER_LETTER * LETTERS;

export function encodeSequence(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1)
    throw new Error("Order sequence must be a positive integer.");
  const index = sequence - 1;
  if (Math.floor(index / VALUES_PER_PREFIX) >= PREFIXES)
    throw new Error("Order sequence exhausted.");
  const serial = String((index % SERIALS_PER_LETTER) + 1).padStart(3, "0");
  const letter = String.fromCharCode(65 + (Math.floor(index / SERIALS_PER_LETTER) % LETTERS));
  const prefix = String(Math.floor(index / VALUES_PER_PREFIX) % PREFIXES).padStart(2, "0");
  return `${prefix}${letter}${serial}`;
}

/** Public order number: US + state code, type code, UTC date, plate sequence.
 *  e.g. USCA-BT-20260922-00A001. The sequence comes from nextOrderSequence()
 *  (atomic Mongo counter); this function only formats. */
export const orderNumber = (type: OrderCertificateType, stateCode: string, sequence: number) =>
  `US${stateCode.toUpperCase()}-${ORDER_TYPE_CODES[type]}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${encodeSequence(sequence)}`;
