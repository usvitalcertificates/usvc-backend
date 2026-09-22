export interface PurchaseDeliveryData {
  transactionId: string;
  amountCents: number;
  serviceCents: number;
  rushCents: number;
  currency: string;
  certificate: string;
  stateCode?: string;
  copies: number;
  rush: boolean;
  clientId?: string;
  sessionId?: string;
}

export function analyticsRetryDelayMs(attempts: number): number {
  return Math.min(3_600_000, 5_000 * 2 ** Math.max(0, attempts - 1));
}

export function buildPurchasePayload(delivery: PurchaseDeliveryData) {
  const certificate = `${delivery.certificate.charAt(0)}${delivery.certificate.slice(1).toLowerCase()} Certificate`;
  return {
    client_id: delivery.clientId || `usvc.server.${delivery.transactionId}`,
    events: [
      {
        name: "purchase",
        params: {
          transaction_id: delivery.transactionId,
          value: delivery.amountCents / 100,
          currency: delivery.currency.toUpperCase(),
          ...(delivery.sessionId ? { session_id: delivery.sessionId } : {}),
          ...(delivery.stateCode ? { state_code: delivery.stateCode } : {}),
          certificate: delivery.certificate,
          items: [
            {
              item_id: `usvc-${delivery.certificate.toLowerCase()}`,
              item_name: certificate,
              item_category: "USVC Processing",
              quantity: delivery.copies,
              price: delivery.serviceCents / delivery.copies / 100,
            },
            ...(delivery.rush
              ? [
                  {
                    item_id: "usvc-rush-processing",
                    item_name: "Rush Processing",
                    item_category: "USVC Processing",
                    quantity: 1,
                    price: delivery.rushCents / 100,
                  },
                ]
              : []),
          ],
        },
      },
    ],
  };
}
