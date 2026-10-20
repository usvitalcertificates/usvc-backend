import { createHash } from "node:crypto";
import type Stripe from "stripe";
import { z } from "zod";
import { Order, type OrderDoc } from "../models/order.js";
import { env } from "../config/env.js";
import { ApiError } from "../middleware/errors.js";
import { dateBounds, dateOnly } from "./staff-dashboards.js";

export type ReadStripe = {
  paymentIntents: Pick<Stripe["paymentIntents"], "list" | "retrieve">;
  charges: Pick<Stripe["charges"], "list" | "retrieve">;
  refunds: Pick<Stripe["refunds"], "list">;
};
export const stripeReference = z.string().regex(/^(pi|ch)_[a-zA-Z0-9_-]{1,200}$/);
export const stripeSearchSchema = z
  .object({
    lookup: z.string().trim().max(120).default(""),
    from: dateOnly.optional(),
    to: dateOnly.optional(),
    cursor: z.string().max(2048).optional(),
  })
  .strict()
  .refine((v) => !v.from || !v.to || v.from <= v.to, "Invalid date range");
const feedCursor = (prefix: string) =>
  z
    .object({
      after: z
        .string()
        .regex(new RegExp(`^${prefix}_[a-zA-Z0-9_-]{1,200}$`))
        .optional(),
      done: z.boolean(),
    })
    .strict();
const cursorSchema = z
  .object({ scope: z.string(), intents: feedCursor("pi"), charges: feedCursor("ch") })
  .strict();
type Cursor = z.infer<typeof cursorSchema>;
type Source = {
  intent?: Stripe.PaymentIntent;
  charge?: Stripe.Charge;
  id: string;
  created: number;
};
const PAGE_SIZE = 25;
const MAX_LIST_CALLS = 6;
const metadata = (source: Source) => source.intent?.metadata ?? source.charge?.metadata ?? {};
const intentId = (source: Source) =>
  source.intent?.id ??
  (typeof source.charge?.payment_intent === "string"
    ? source.charge.payment_intent
    : source.charge?.payment_intent?.id);
function latestCharge(intent: Stripe.PaymentIntent): Stripe.Charge | undefined {
  return intent.latest_charge && typeof intent.latest_charge !== "string"
    ? intent.latest_charge
    : undefined;
}
export function failureDescription(code?: string | null): string | null {
  if (!code) return null;
  const known: Record<string, string> = {
    card_declined: "The card was declined.",
    insufficient_funds: "The card had insufficient funds.",
    expired_card: "The card was expired.",
    incorrect_cvc: "The security code was incorrect.",
    incorrect_number: "The card number was incorrect.",
    authentication_required: "Additional card verification was required.",
    processing_error: "The payment processor could not complete this attempt.",
  };
  return (
    known[code] ?? "This payment attempt did not complete. The provider returned a payment error."
  );
}
function paymentStatus(source: Source): string {
  const charge = source.charge ?? (source.intent ? latestCharge(source.intent) : undefined);
  if (charge?.amount_refunded && charge.amount_refunded >= charge.amount) return "refunded";
  if (charge?.amount_refunded) return "partially_refunded";
  if (source.intent && !source.charge) {
    if (source.intent.status === "requires_payment_method")
      return source.intent.last_payment_error || charge?.status === "failed"
        ? "failed"
        : "awaiting_payment";
    return source.intent.status;
  }
  return charge?.status ?? "unknown";
}
const matchProjection = {
  publicNumber: 1,
  paymentStatus: 1,
  amountCents: 1,
  currency: 1,
  stripePaymentIntentId: 1,
  "applicant.firstName": 1,
  "applicant.lastName": 1,
  "applicant.email": 1,
};
type MatchedOrder = Pick<
  OrderDoc,
  | "publicNumber"
  | "paymentStatus"
  | "amountCents"
  | "currency"
  | "stripePaymentIntentId"
  | "applicant"
> & { _id: unknown };
async function matchOrders(sources: Source[]) {
  if (!sources.length) return [];
  const ids = sources
    .map((s) => metadata(s).orderId)
    .filter((v): v is string => !!v && /^[a-f\d]{24}$/i.test(v));
  const numbers = sources.map((s) => metadata(s).orderNumber).filter(Boolean);
  const refs = sources.map(intentId).filter(Boolean);
  const orders = (await Order.find(
    {
      $or: [
        { _id: { $in: ids } },
        { publicNumber: { $in: numbers } },
        { stripePaymentIntentId: { $in: refs } },
      ],
    },
    matchProjection,
  ).lean()) as MatchedOrder[];
  return sources.map((source) => {
    const meta = metadata(source);
    const reference = intentId(source);
    const order =
      (reference
        ? orders.find((o: MatchedOrder) => o.stripePaymentIntentId === reference)
        : undefined) ??
      orders.find(
        (o: MatchedOrder) => String(o._id) === meta.orderId || o.publicNumber === meta.orderNumber,
      );
    const charge = source.charge ?? (source.intent ? latestCharge(source.intent) : undefined);
    const status = paymentStatus(source);
    const amountCents = source.charge?.amount ?? source.intent?.amount ?? 0;
    const currency = source.charge?.currency ?? source.intent?.currency ?? "usd";
    const expected =
      status === "refunded"
        ? "REFUNDED"
        : ["succeeded", "partially_refunded"].includes(status)
          ? "PAID"
          : ["failed", "canceled"].includes(status)
            ? "FAILED"
            : "PENDING";
    const amountMismatch =
      !!order && (order.amountCents !== amountCents || order.currency !== currency);
    const discrepancy =
      order && (amountMismatch || (expected && order.paymentStatus !== expected))
        ? amountMismatch
          ? "Payment amount or currency differs from Flow."
          : "Stripe and Flow payment statuses differ."
        : null;
    return {
      id: source.id,
      paymentIntentId: intentId(source) ?? null,
      chargeId: charge?.id ?? null,
      createdAt: new Date(source.created * 1000).toISOString(),
      amountCents,
      currency,
      status,
      stripeStatus: String(source.charge?.status ?? source.intent?.status ?? "unknown"),
      refundedCents: charge?.amount_refunded ?? 0,
      customerName:
        charge?.billing_details?.name ||
        [order?.applicant?.firstName, order?.applicant?.lastName].filter(Boolean).join(" "),
      email:
        source.intent?.receipt_email ||
        charge?.billing_details?.email ||
        order?.applicant?.email ||
        "",
      mode: (source.intent?.livemode ?? charge?.livemode) ? "live" : "test",
      card: charge?.payment_method_details?.card
        ? {
            brand: String(charge.payment_method_details.card.brand),
            last4: charge.payment_method_details.card.last4,
          }
        : null,
      failure: ["succeeded", "refunded", "partially_refunded"].includes(status)
        ? null
        : failureDescription(
            source.intent?.last_payment_error?.decline_code ??
              source.intent?.last_payment_error?.code ??
              charge?.failure_code,
          ),
      order: order
        ? {
            id: String(order._id),
            publicNumber: order.publicNumber,
            paymentStatus: order.paymentStatus,
            amountCents: order.amountCents,
            currency: order.currency,
          }
        : null,
      discrepancy,
    };
  });
}

export async function stripePaymentDetail(
  stripe: ReadStripe,
  reference: string,
  cursors: { attemptAfter?: string; refundAfter?: string } = {},
) {
  let source: Source;
  if (reference.startsWith("pi_")) {
    const intent = await stripe.paymentIntents.retrieve(reference, { expand: ["latest_charge"] });
    source = { intent, id: intent.id, created: intent.created };
  } else {
    const charge = await stripe.charges.retrieve(reference);
    source = { charge, id: charge.id, created: charge.created };
  }
  const piId = intentId(source);
  // Always retrieve an associated intent for current status, even when looked up by Charge ID.
  if (!source.intent && piId)
    source.intent = await stripe.paymentIntents.retrieve(piId, { expand: ["latest_charge"] });
  const [payment] = await matchOrders([source]);
  const [attempts, refunds] = await Promise.all([
    piId
      ? stripe.charges.list({
          payment_intent: piId,
          limit: PAGE_SIZE,
          starting_after: cursors.attemptAfter,
        })
      : Promise.resolve({ data: source.charge ? [source.charge] : [], has_more: false }),
    stripe.refunds.list({
      ...(piId ? { payment_intent: piId } : { charge: source.id }),
      limit: PAGE_SIZE,
      starting_after: cursors.refundAfter,
    }),
  ]);
  return {
    payment,
    checkedAt: new Date().toISOString(),
    attempts: {
      items: attempts.data.map((charge) => ({
        id: charge.id,
        createdAt: new Date(charge.created * 1000).toISOString(),
        amountCents: charge.amount,
        currency: charge.currency,
        status: String(charge.status),
        failure: failureDescription(charge.failure_code),
        card: charge.payment_method_details?.card
          ? {
              brand: String(charge.payment_method_details.card.brand),
              last4: charge.payment_method_details.card.last4,
            }
          : null,
      })),
      nextCursor: attempts.has_more ? (attempts.data.at(-1)?.id ?? null) : null,
    },
    refunds: {
      items: refunds.data.map((refund) => ({
        id: refund.id,
        createdAt: new Date(refund.created * 1000).toISOString(),
        amountCents: refund.amount,
        currency: refund.currency,
        status: String(refund.status ?? "unknown"),
      })),
      nextCursor: refunds.has_more ? (refunds.data.at(-1)?.id ?? null) : null,
    },
  };
}

export async function stripePaymentSearch(
  stripe: ReadStripe,
  input: z.infer<typeof stripeSearchSchema>,
) {
  const mode = env.PAYMENT_ENVIRONMENT;
  if (/^(pi|ch)_/.test(input.lookup)) {
    const detail = await stripePaymentDetail(stripe, stripeReference.parse(input.lookup));
    return {
      payments: [detail.payment],
      nextCursor: null,
      hasMore: false,
      checkedAt: detail.checkedAt,
      mode,
      scanning: false,
    };
  }
  let order: { _id?: unknown; publicNumber: string; stripePaymentIntentId?: string } | null = null;
  if (input.lookup) {
    if (!/^US[A-Z0-9-]{4,119}$/i.test(input.lookup))
      throw new ApiError(400, "Enter an exact Flow order number or Stripe payment ID.");
    const existing = await Order.findOne(
      { publicNumber: input.lookup.toUpperCase() },
      { publicNumber: 1, stripePaymentIntentId: 1 },
    ).lean();
    // Stripe can retain a reference even when the local order is absent.
    order = existing ?? { publicNumber: input.lookup.toUpperCase() };
  }
  const scope = createHash("sha256")
    .update(JSON.stringify([mode, input.from, input.to, input.lookup.toUpperCase()]))
    .digest("hex");
  let cursor: Cursor = { scope, intents: { done: false }, charges: { done: false } };
  if (input.cursor) {
    try {
      cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")),
      );
      if (cursor.scope !== scope) throw new Error();
    } catch {
      throw new ApiError(400, "Invalid history cursor. Refresh the payment list.");
    }
  }
  const dates = dateBounds(input.from, input.to);
  const created =
    input.from || input.to
      ? {
          ...(dates.$gte ? { gte: Math.floor(dates.$gte.getTime() / 1000) } : {}),
          ...(dates.$lt ? { lt: Math.floor(dates.$lt.getTime() / 1000) } : {}),
        }
      : undefined;
  // Merge two live feeds without maintaining a payment mirror. The cursor
  // advances only consumed records, so look-ahead is never lost between pages.
  const buffers: Record<"intents" | "charges", Source[]> = { intents: [], charges: [] };
  const exhausted = { intents: false, charges: false };
  let calls = 0;
  const head = async (kind: "intents" | "charges"): Promise<Source | null | undefined> => {
    if (buffers[kind].length) return buffers[kind][0];
    if (cursor[kind].done) return null;
    if (exhausted[kind]) {
      cursor[kind].done = true;
      return null;
    }
    if (calls >= MAX_LIST_CALLS) return undefined;
    calls++;
    const args = { created, limit: PAGE_SIZE, starting_after: cursor[kind].after };
    if (kind === "intents") {
      const page = await stripe.paymentIntents.list({ ...args, expand: ["data.latest_charge"] });
      buffers.intents = page.data.map((intent) => ({
        intent,
        id: intent.id,
        created: intent.created,
      }));
      exhausted.intents = !page.has_more;
    } else {
      const page = await stripe.charges.list(args);
      buffers.charges = page.data.map((charge) => ({
        charge,
        id: charge.id,
        created: charge.created,
      }));
      exhausted.charges = !page.has_more;
    }
    if (!buffers[kind].length) {
      cursor[kind].done = true;
      return null;
    }
    return buffers[kind][0];
  };
  const selected: Source[] = [];
  while (selected.length < PAGE_SIZE) {
    const left = await head("intents");
    const right = await head("charges");
    if (left === undefined || right === undefined || (!left && !right)) break;
    const kind = !right || (left && left.created >= right.created) ? "intents" : "charges";
    const source = buffers[kind].shift()!;
    cursor[kind].after = source.id;
    if (!buffers[kind].length && exhausted[kind]) cursor[kind].done = true;
    // Modern Charges are already represented by their intent in the other feed.
    if (source.charge?.payment_intent) continue;
    const meta = metadata(source);
    if (
      order &&
      !(
        (order._id && meta.orderId === String(order._id)) ||
        meta.orderNumber === order.publicNumber ||
        (order.stripePaymentIntentId && intentId(source) === order.stripePaymentIntentId)
      )
    )
      continue;
    selected.push(source);
  }
  const hasMore = !cursor.intents.done || !cursor.charges.done;
  return {
    payments: await matchOrders(selected),
    hasMore,
    nextCursor: hasMore ? Buffer.from(JSON.stringify(cursor)).toString("base64url") : null,
    checkedAt: new Date().toISOString(),
    mode,
    scanning: !!order && hasMore,
  };
}
