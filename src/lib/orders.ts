export const priceOrder = (copies: number, rush: boolean, international: boolean) =>
  copies * (12500 + (international ? 13300 : 11300)) + (rush ? 3000 : 0);
export const orderNumber = (type: string) =>
  `USVC-${type.slice(0, 2)}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
