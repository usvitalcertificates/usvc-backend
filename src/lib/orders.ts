/** Two-fee model: only the Online Processing Fee (+ optional rush) is charged
 *  now. Government / agency / shipping fees are charged separately later via
 *  the stored card — never in this total. */
export const priceOrder = (copies: number, rush: boolean, _international: boolean) =>
  copies * 12500 + (rush ? 3000 : 0);

export const ORDER_TYPE_CODES = {
  BIRTH: "BT",
  DEATH: "DT",
  MARRIAGE: "MG",
  DIVORCE: "DV",
} as const;

export type OrderCertificateType = keyof typeof ORDER_TYPE_CODES;

export const orderNumber = (type: OrderCertificateType) =>
  `USVC-${ORDER_TYPE_CODES[type]}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
