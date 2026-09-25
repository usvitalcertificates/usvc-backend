export interface OpenAIConversionData {
  eventId: string;
  occurredAt: Date;
  amountCents: number;
  currency: string;
  certificate: string;
  copies: number;
  oppref?: string;
  obref?: string;
}

export function buildOpenAIConversionPayload(delivery: OpenAIConversionData, sourceUrl: string) {
  const certificateName = `${delivery.certificate.charAt(0)}${delivery.certificate.slice(1).toLowerCase()} Certificate`;
  return {
    validate_only: false,
    events: [
      {
        id: delivery.eventId,
        type: "order_created",
        timestamp_ms: delivery.occurredAt.getTime(),
        ...(delivery.oppref ? { oppref: delivery.oppref } : {}),
        source_url: sourceUrl,
        action_source: "web",
        ...(delivery.obref ? { user: { obref: delivery.obref } } : {}),
        data: {
          type: "contents",
          amount: delivery.amountCents,
          currency: delivery.currency.toUpperCase(),
          contents: [
            {
              id: `usvc-${delivery.certificate.toLowerCase()}`,
              name: certificateName,
              content_type: "product",
              quantity: delivery.copies,
            },
          ],
        },
      },
    ],
  };
}
