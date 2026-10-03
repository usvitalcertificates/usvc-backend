import type Stripe from "stripe";

/** Synchronous service-fee charge for straight-through payment.
 *  The application form collects the card once; POST /orders charges it
 *  immediately from the encrypted stored details and returns paid/failed in
 *  the same response. Only the Online Processing Fee (+ rush) is ever charged
 *  here — agency/shipping fees are the agency's own later charge.
 *
 *  No PAN/CVC ever enters logs, errors, or audit metadata — only Stripe IDs
 *  and decline codes cross these boundaries.
 */

export interface ServiceChargeCard {
  number: string;
  expiry: string;
  securityCode: string;
}

export interface ServiceChargeParams {
  orderId: string;
  orderNumber: string;
  email: string;
  /** Server-computed total (pricing.totalCents). Browser totals are never trusted. */
  amountCents: number;
  card: ServiceChargeCard;
}

export type ServiceChargeResult =
  | { ok: true; paymentIntentId: string }
  | {
      ok: false;
      httpStatus: 402 | 502;
      code: string;
      message: string;
    };

export const DECLINED_MESSAGE =
  "Your card was declined. Check the details or try another card (Visa or Mastercard).";

export const VERIFICATION_REQUIRED_MESSAGE =
  "Your card needs extra verification to complete this payment. Please try another card (Visa or Mastercard).";

export const PROCESSOR_ERROR_MESSAGE =
  "Payment could not be processed right now. Please try again in a moment.";

/** Parse MM/YY into Stripe's exp_month/exp_year. Null on bad format
 *  (format/expiry validity itself is enforced by order validation). */
export function parseCardExpiry(expiry: string): { expMonth: number; expYear: number } | null {
  const match = /^(0[1-9]|1[0-2])\/(\d{2})$/.exec(expiry.trim());
  if (!match) return null;
  return { expMonth: Number(match[1]), expYear: 2000 + Number(match[2]) };
}

function isStripeCardError(e: unknown): e is { code?: string; message: string } {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { type?: string }).type === "StripeCardError" &&
    typeof (e as { message?: unknown }).message === "string"
  );
}

export async function chargeServiceFee(
  stripe: Stripe,
  params: ServiceChargeParams,
): Promise<ServiceChargeResult> {
  const digits = params.card.number.replace(/[\s-]/g, "");
  const exp = parseCardExpiry(params.card.expiry);
  const cvc = params.card.securityCode.trim();
  if (!exp || !/^\d{3}$/.test(cvc)) {
    return { ok: false, httpStatus: 402, code: "invalid_card", message: DECLINED_MESSAGE };
  }
  try {
    const paymentMethod = await stripe.paymentMethods.create({
      type: "card",
      card: {
        number: digits,
        exp_month: exp.expMonth,
        exp_year: exp.expYear,
        cvc,
      },
    });
    const intent = await stripe.paymentIntents.create(
      {
        amount: params.amountCents,
        currency: "usd",
        payment_method: paymentMethod.id,
        confirm: true,
        description: `USVC ${params.orderNumber} — Online Processing Fee`,
        receipt_email: params.email || undefined,
        metadata: { orderId: params.orderId, orderNumber: params.orderNumber },
      },
      { idempotencyKey: `usvc_order_charge_${params.orderId}` },
    );
    if (intent.status === "succeeded") {
      return { ok: true, paymentIntentId: intent.id };
    }
    if (intent.status === "requires_action") {
      return {
        ok: false,
        httpStatus: 402,
        code: "authentication_required",
        message: VERIFICATION_REQUIRED_MESSAGE,
      };
    }
    return { ok: false, httpStatus: 402, code: "card_declined", message: DECLINED_MESSAGE };
  } catch (e) {
    if (isStripeCardError(e)) {
      return {
        ok: false,
        httpStatus: 402,
        code: e.code ?? "card_declined",
        // Stripe card-error messages are designed for customer display.
        message: e.message || DECLINED_MESSAGE,
      };
    }
    throw e;
  }
}
