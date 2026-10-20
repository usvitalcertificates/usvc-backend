import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import Stripe from "stripe";
import { app } from "../app.js";
import { env } from "../config/env.js";
import { Order } from "../models/order.js";
import { EmailOutbox } from "../models/email-outbox.js";
import { AnalyticsPurchaseDelivery } from "../models/analytics-purchase-delivery.js";
import { OpenAIConversionDelivery } from "../models/openai-conversion-delivery.js";
import { GoogleChatDelivery } from "../models/google-chat-delivery.js";
import { StripeEvent } from "../models/staff.js";
import {
  ensureDirectIntent,
  ensureCheckoutSession,
  newPaymentAttempt,
  reconcilePayment,
  reservationFilter,
} from "./payment-attempts.js";
import { intentNotice, recordPayment } from "./payment-state.js";

/** Run against an isolated local replica set:
 * PAYMENT_TEST_MONGODB_URI=mongodb://127.0.0.1:27941/?replicaSet=usvc-payment-safety npm test
 * Stripe is entirely mocked; no payment provider or production DB is contacted. */
const uri = process.env.PAYMENT_TEST_MONGODB_URI;
test(
  "payment safety with real Mongo transactions and mocked Stripe",
  { skip: !uri, timeout: 30_000 },
  async (t) => {
    assert.match(uri!, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//);
    const dbName = `usvc_payment_test_${randomUUID().replaceAll("-", "")}`;
    await mongoose.connect(uri!, { dbName, serverSelectionTimeoutMS: 5_000 });
    env.ANALYTICS_ENABLED = true;
    env.OPENAI_CONVERSIONS_ENABLED = true;
    env.PAYMENT_ENVIRONMENT = "test";
    const stripe = new Stripe("sk_test_local_only");
    const intents = new Map<string, Stripe.PaymentIntent>();
    const sessions = new Map<string, Stripe.Checkout.Session>();
    const keys = new Map<string, string>();
    let confirms = 0;
    let loseCreateResponse = false;
    let loseConfirmResponse = false;
    let confirmStatus: Stripe.PaymentIntent.Status = "succeeded";
    let unavailable = false;
    let confirmationGate: Promise<void> | undefined;
    let onConfirmation: (() => void) | undefined;
    let createGate: Promise<void> | undefined;
    let onCreate: (() => void) | undefined;
    let loseCheckoutCreateResponse = false;
    let confirmationWinsCancellation = false;
    const intentProto = Object.getPrototypeOf(stripe.paymentIntents);
    const checkoutProto = Object.getPrototypeOf(stripe.checkout.sessions);
    const mocks = [
      t.mock.method(
        intentProto,
        "create",
        async (args: Stripe.PaymentIntentCreateParams, opts: Stripe.RequestOptions) => {
          if (unavailable) throw new Error("Stripe unavailable");
          assert.ok(
            !args.confirm && !args.payment_method && !args.payment_method_data,
            "creation cannot charge",
          );
          let id = keys.get(opts.idempotencyKey!);
          if (!id) {
            id = `pi_${randomUUID()}`;
            keys.set(opts.idempotencyKey!, id);
            intents.set(id, {
              id,
              amount: args.amount,
              amount_received: 0,
              currency: args.currency,
              metadata: args.metadata,
              livemode: false,
              status: "requires_payment_method",
            } as Stripe.PaymentIntent);
          }
          onCreate?.();
          await createGate;
          if (loseCreateResponse) {
            loseCreateResponse = false;
            throw new Error("Lost create response");
          }
          return structuredClone(intents.get(id));
        },
      ),
      t.mock.method(intentProto, "retrieve", async (id: string) => {
        if (unavailable) throw new Error("Stripe unavailable");
        assert.ok(intents.has(id));
        return structuredClone(intents.get(id));
      }),
      t.mock.method(intentProto, "confirm", async (id: string) => {
        confirms++;
        const intent = intents.get(id)!;
        const order = await Order.findById(intent.metadata.orderId).lean();
        assert.equal(order.stripePaymentIntentId, id, "intent must be saved before confirming");
        onConfirmation?.();
        await confirmationGate;
        if (intent.status === "canceled") throw new Error("Already cancelled");
        intent.status = confirmStatus;
        intent.amount_received = confirmStatus === "succeeded" ? intent.amount : 0;
        if (loseConfirmResponse) {
          loseConfirmResponse = false;
          throw new Error("Lost confirm response");
        }
        return structuredClone(intent);
      }),
      t.mock.method(intentProto, "cancel", async (id: string) => {
        if (unavailable) throw new Error("Stripe unavailable");
        const intent = intents.get(id)!;
        if (confirmationWinsCancellation) {
          confirmationWinsCancellation = false;
          intent.status = "succeeded";
          intent.amount_received = intent.amount;
          throw new Error("Confirmation won cancellation");
        }
        if (["succeeded", "processing"].includes(intent.status)) throw new Error("Cannot cancel");
        intent.status = "canceled";
        return structuredClone(intent);
      }),
      t.mock.method(Object.getPrototypeOf(stripe.paymentMethods), "create", async () => ({
        id: "pm_local",
      })),
      t.mock.method(
        checkoutProto,
        "create",
        async (args: Stripe.Checkout.SessionCreateParams, opts: Stripe.RequestOptions) => {
          let id = keys.get(opts.idempotencyKey!);
          if (!id) {
            id = `cs_${randomUUID()}`;
            keys.set(opts.idempotencyKey!, id);
            sessions.set(id, {
              id,
              amount_total: args.line_items!.reduce((sum, item) => {
                assert.ok(Number.isInteger(item.price_data!.unit_amount));
                return sum + item.quantity! * item.price_data!.unit_amount!;
              }, 0),
              currency: "usd",
              metadata: args.metadata,
              livemode: false,
              payment_status: "unpaid",
              status: "open",
              payment_intent: null,
              client_secret: "cs_local_secret",
            } as Stripe.Checkout.Session);
          }
          if (loseCheckoutCreateResponse) {
            loseCheckoutCreateResponse = false;
            throw new Error("Lost Checkout create response");
          }
          return structuredClone(sessions.get(id));
        },
      ),
      t.mock.method(checkoutProto, "retrieve", async (id: string) => {
        if (unavailable) throw new Error("Stripe unavailable");
        assert.ok(sessions.has(id));
        return structuredClone(sessions.get(id));
      }),
    ];
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const post = async (path: string, data: unknown) => {
      const response = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      });
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    };
    const webhook = async (
      intent: Stripe.PaymentIntent,
      type = "payment_intent.succeeded",
      eventId = `evt_${randomUUID()}`,
    ) => {
      const payload = JSON.stringify({
        id: eventId,
        type,
        created: Math.floor(Date.now() / 1000),
        data: { object: intent },
      });
      const signature = stripe.webhooks.generateTestHeaderString({
        payload,
        secret: env.STRIPE_WEBHOOK_SECRET,
      });
      const response = await fetch(`${origin}/webhooks/stripe`, {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": signature },
        body: payload,
      });
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    };
    let seq = 0;
    const payload = () => ({
      submissionKey: randomUUID(),
      stateSlug: "alabama",
      stateCode: "AL",
      stateName: "Alabama",
      certificate: "BIRTH",
      county: "Jefferson",
      city: "Birmingham",
      reason: "Passport / travel",
      applicant: {
        relationship: "Parent",
        firstName: "Jane",
        lastName: "Doe",
        dateOfBirth: "1990-05-20",
        phone: "+15550100100",
        email: "jane@example.com",
      },
      subject: {
        firstName: "Baby",
        lastName: "Doe",
        eventDate: "2020-01-15",
        sex: "Female",
        subjectMaidenLastName: "Doe",
        stillLiving: "Yes",
      },
      family: {
        motherFirstName: "Jane",
        motherCurrentLastName: "Doe",
        motherLastName: "Smith",
        fatherStatus: "Unknown",
      },
      requestorSsn: "123-45-6789",
      copies: 1,
      rush: false,
      destinationType: "domestic",
      addresses: Object.fromEntries(
        ["home", "shipping", "billing"].map((k) => [
          k,
          { line1: "1 Main St", city: "Birmingham", state: "AL", postalCode: "35203" },
        ]),
      ),
      consents: {
        accurate: true,
        govtId: true,
        terms: true,
        privacy: true,
        refund: true,
        processingPayment: true,
      },
      processingAuthorization: {
        accepted: true,
        text: "I authorize USVC to charge the complete total shown on my order.",
        acceptedAt: new Date().toISOString(),
      },
      signature: "Jane Doe",
      paymentCard: { number: "4111111111111111", expiry: "12/30", securityCode: "123" },
      totalCents: 14900,
    });
    const makeOrder = async (extra: Record<string, unknown> = {}) => {
      const input = payload();
      const created = await Order.create({
        ...input,
        publicNumber: `TEST-${++seq}`,
        geo: { county: input.county, city: input.city },
        pricing: { serviceCents: 14900, rushCents: 0, totalCents: 14900 },
        amountCents: 14900,
        currency: "usd",
        status: "AWAITING_PAYMENT",
        paymentStatus: "PENDING",
        paymentAttempt: newPaymentAttempt("DIRECT"),
        ...extra,
      });
      return created.toObject();
    };
    const saveIntent = async (extra: Record<string, unknown> = {}) => {
      const order = await makeOrder(extra);
      const intent = await ensureDirectIntent(stripe, order);
      return { order: await Order.findById(order._id).lean(), intent: intents.get(intent.id)! };
    };
    try {
      await Promise.all(
        [
          Order,
          EmailOutbox,
          AnalyticsPurchaseDelivery,
          OpenAIConversionDelivery,
          GoogleChatDelivery,
          StripeEvent,
        ].map((model) => model.init()),
      );

      await t.test(
        "overlapping submissions charge once and keep the second request on the form",
        async () => {
          const input = payload();
          const before = confirms;
          let release!: () => void;
          confirmationGate = new Promise((resolve) => {
            release = resolve;
          });
          const entered = new Promise<void>((resolve) => {
            onConfirmation = resolve;
          });
          const first = post("/orders", input);
          await entered;
          try {
            const second = await post("/orders", {
              ...input,
              applicant: { ...input.applicant, firstName: "Changed" },
            });
            assert.equal(second.status, 423);
            assert.match(second.body.message, /still being checked/);
            assert.equal(second.body.orderId, undefined);
            const stored = await Order.findOne({ submissionKey: input.submissionKey }).lean();
            assert.equal(
              stored.applicant.firstName,
              "Jane",
              "a blocked request must not change the application",
            );
          } finally {
            release();
            confirmationGate = undefined;
            onConfirmation = undefined;
          }
          const result = await first;
          assert.equal(result.status, 201, JSON.stringify(result.body));
          assert.equal(result.body.paid, true);
          assert.equal(confirms - before, 1);
          const repeated = await post("/orders", input);
          assert.equal(repeated.status, 409);
          assert.equal(repeated.body.orderId, result.body.id);
        },
      );

      await t.test("the unique submission key fences two simultaneous creates", async () => {
        const input = payload();
        const before = confirms;
        const results = await Promise.all([post("/orders", input), post("/orders", input)]);
        assert.equal(results.filter((r) => r.status === 201).length, 1, JSON.stringify(results));
        assert.ok(results.some((r) => [409, 423].includes(r.status)));
        assert.equal(confirms - before, 1);
        assert.equal(await Order.countDocuments({ submissionKey: input.submissionKey }), 1);
      });

      await t.test(
        "discounted copies charge server totals and Checkout uses integer line items",
        async () => {
          const direct = await post("/orders", {
            ...payload(),
            copies: 9,
            rush: true,
            totalCents: 72100,
          });
          assert.equal(direct.status, 201, JSON.stringify(direct.body));
          const paid = await Order.findById(direct.body.id).lean();
          assert.equal(paid.amountCents, 72100);
          assert.equal(intents.get(paid.stripePaymentIntentId)!.amount, 72100);
          const legacy = await makeOrder({
            copies: 9,
            paymentAttempt: undefined,
            amountCents: 134100,
            pricing: { serviceCents: 134100, rushCents: 0, totalCents: 134100 },
          });
          await Order.updateOne({ _id: legacy._id }, { $unset: { applicationRevision: 1 } });
          const checkout = await post(`/orders/${legacy._id}/checkout-session`, {});
          assert.equal(checkout.status, 200, JSON.stringify(checkout.body));
          assert.equal(checkout.body.amountCents, 70900);
          const latest = await Order.findById(legacy._id).lean();
          assert.equal(sessions.get(latest.stripeCheckoutSessionId)!.amount_total, 70900);
        },
      );
      await t.test("a lost confirmation response resolves the same successful charge", async () => {
        loseConfirmResponse = true;
        const before = confirms;
        const result = await post("/orders", payload());
        assert.equal(result.status, 201, JSON.stringify(result.body));
        assert.equal(confirms - before, 1);
      });

      await t.test("a declined intent is cancelled before a fresh attempt can charge", async () => {
        const input = payload();
        const emailEnabled = env.EMAIL_ENABLED;
        env.EMAIL_ENABLED = true;
        confirmStatus = "requires_payment_method";
        const declined = await post("/orders", input);
        assert.equal(declined.status, 402, JSON.stringify(declined.body));
        const first = await Order.findOne({ submissionKey: input.submissionKey }).lean();
        assert.equal(first.paymentAttempt.state, "FAILED");
        assert.equal(
          (await EmailOutbox.findById(`payment_recovery_${first._id}`).lean())?.template,
          "PAYMENT_RECOVERY",
        );
        env.EMAIL_ENABLED = emailEnabled;
        assert.equal(intents.get(first.stripePaymentIntentId)!.status, "canceled");
        confirmStatus = "succeeded";
        const result = await post("/orders", input);
        assert.equal(result.status, 201, JSON.stringify(result.body));
        const second = await Order.findById(first._id).lean();
        assert.notEqual(second.paymentAttempt.id, first.paymentAttempt.id);
        assert.notEqual(second.stripePaymentIntentId, first.stripePaymentIntentId);
      });

      await t.test("two retries of a declined order reserve only one new charge", async () => {
        const input = payload();
        const failed = await makeOrder({
          ...input,
          paymentStatus: "FAILED",
          paymentAttempt: { ...newPaymentAttempt("DIRECT"), state: "FAILED" },
          chargeAttempts: 1,
        });
        const before = confirms;
        const results = await Promise.all([post("/orders", input), post("/orders", input)]);
        assert.equal(results.filter((r) => r.status === 201).length, 1, JSON.stringify(results));
        assert.ok(results.some((r) => [409, 423].includes(r.status)));
        assert.equal(confirms - before, 1);
        const latest = await Order.findById(failed._id).lean();
        assert.equal(latest.paymentStatus, "PAID");
      });

      await t.test("processing or unreachable payments never unlock", async () => {
        const { order, intent } = await saveIntent();
        intent.status = "processing";
        assert.equal(await reconcilePayment(stripe, order, true), "PENDING");
        unavailable = true;
        try {
          await assert.rejects(reconcilePayment(stripe, order, true));
        } finally {
          unavailable = false;
        }
        const latest = await Order.findById(order._id).lean();
        assert.equal(latest.paymentAttempt.state, "READY");
        assert.equal(
          await Order.findOneAndUpdate(reservationFilter(latest), {
            $set: { paymentAttempt: newPaymentAttempt("DIRECT") },
          }),
          null,
        );
      });

      await t.test(
        "a crash after intent creation recovers its stable key before cancelling",
        async () => {
          const order = await makeOrder();
          loseCreateResponse = true;
          const before = intents.size;
          await assert.rejects(ensureDirectIntent(stripe, order));
          assert.equal(intents.size - before, 1);
          assert.equal((await Order.findById(order._id).lean()).stripePaymentIntentId, undefined);
          await Order.updateOne(
            { _id: order._id },
            { $set: { "paymentAttempt.startedAt": new Date(Date.now() - 120_000) } },
          );
          const recovered = await Order.findById(order._id).lean();
          assert.equal(await reconcilePayment(stripe, recovered), "RETRY");
          assert.equal(intents.size - before, 1, "recovery cannot create a second intent");
          const latest = await Order.findById(order._id).lean();
          assert.equal(latest.paymentAttempt.state, "FAILED");
          assert.equal(intents.get(latest.stripePaymentIntentId)!.status, "canceled");
        },
      );

      await t.test("a crash after saving the intent cancels that intent before retry", async () => {
        const { order, intent } = await saveIntent({
          paymentAttempt: {
            ...newPaymentAttempt("DIRECT"),
            startedAt: new Date(Date.now() - 120_000),
          },
        });
        assert.equal(await reconcilePayment(stripe, order), "RETRY");
        assert.equal(intent.status, "canceled");
      });

      await t.test("old idempotency keys and unknown legacy charges stay blocked", async () => {
        const old = await makeOrder({
          paymentAttempt: {
            ...newPaymentAttempt("DIRECT"),
            startedAt: new Date(Date.now() - 25 * 3600_000),
          },
        });
        await assert.rejects(reconcilePayment(stripe, old), (e: any) => e.status === 423);
        const legacy = await makeOrder({
          paymentAttempt: undefined,
          chargeAttempts: 1,
          paymentStatus: "FAILED",
        });
        assert.equal(await reconcilePayment(stripe, legacy), "PENDING");
      });

      await t.test("late success preserves workflow and original milestone dates", async () => {
        for (const status of ["IN_REVIEW", "TO_CS", "GTG", "SUBMITTED", "CANCELLED"]) {
          const original = new Date("2026-01-01T12:00:00Z");
          const { order, intent } = await saveIntent({
            status,
            customerTimeline: { paymentSuccessfulAt: original, orderReceivedAt: original },
          });
          intent.status = "succeeded";
          intent.amount_received = intent.amount;
          assert.equal(await recordPayment(intentNotice(intent)), true);
          const latest = await Order.findById(order._id).lean();
          assert.equal(latest.status, status);
          assert.equal(latest.customerTimeline.paymentSuccessfulAt.getTime(), original.getTime());
          assert.equal(latest.customerTimeline.orderReceivedAt.getTime(), original.getTime());
        }
      });

      await t.test(
        "paid and refunded orders reject late failure; refunded stays refunded on success",
        async () => {
          for (const paymentStatus of ["PAID", "REFUNDED"]) {
            const { order, intent } = await saveIntent();
            await Order.updateOne(
              { _id: order._id },
              { $set: { paymentStatus, status: "SUBMITTED" } },
            );
            await recordPayment(intentNotice(intent));
            intent.status = "succeeded";
            intent.amount_received = intent.amount;
            await recordPayment(intentNotice(intent));
            assert.equal((await Order.findById(order._id).lean()).paymentStatus, paymentStatus);
          }
        },
      );

      await t.test(
        "wrong amount, currency, environment, owner, intent or attempt cannot settle",
        async () => {
          const { order, intent } = await saveIntent();
          intent.status = "succeeded";
          intent.amount_received = intent.amount;
          const good = intentNotice(intent);
          for (const patch of [
            { amountCents: 1 },
            { currency: "eur" },
            { livemode: true },
            { orderId: String(new mongoose.Types.ObjectId()) },
            { intentId: "pi_wrong" },
            { attemptId: "old_attempt" },
          ]) {
            assert.equal(await recordPayment({ ...good, ...patch }), false);
          }
          assert.equal((await Order.findById(order._id).lean()).paymentStatus, "PENDING");
        },
      );

      await t.test("a failure from an earlier attempt is ignored", async () => {
        const { order, intent } = await saveIntent();
        await Order.updateOne(
          { _id: order._id },
          {
            $set: { paymentAttempt: newPaymentAttempt("DIRECT"), stripePaymentIntentId: "pi_new" },
          },
        );
        await recordPayment(intentNotice(intent));
        assert.equal((await Order.findById(order._id).lean()).paymentStatus, "PENDING");
      });

      await t.test("different success events and duplicate deliveries enqueue once", async () => {
        const { order, intent } = await saveIntent();
        intent.status = "succeeded";
        intent.amount_received = intent.amount;
        const eventId = `evt_${randomUUID()}`;
        assert.equal((await webhook(intent, undefined, eventId)).status, 200);
        const duplicate = await webhook(intent, undefined, eventId);
        assert.equal(duplicate.body.duplicate, true);
        assert.equal((await webhook(intent)).status, 200);
        // A stale failure snapshot is resolved against the current succeeded intent.
        assert.equal(
          (
            await webhook(
              { ...intent, status: "requires_payment_method" },
              "payment_intent.payment_failed",
            )
          ).status,
          200,
        );
        for (const model of [
          EmailOutbox,
          AnalyticsPurchaseDelivery,
          OpenAIConversionDelivery,
          GoogleChatDelivery,
        ])
          assert.equal(await model.countDocuments({ orderId: order._id }), 1);
        assert.equal((await Order.findById(order._id).lean()).paymentStatus, "PAID");
      });

      await t.test(
        "delivery failure rolls back event and payment so Stripe can retry",
        async () => {
          const { order, intent } = await saveIntent();
          intent.status = "succeeded";
          intent.amount_received = intent.amount;
          const eventId = `evt_${randomUUID()}`;
          const failure = t.mock.method(EmailOutbox, "updateOne", () => {
            throw new Error("Simulated delivery DB failure");
          });
          try {
            assert.equal((await webhook(intent, undefined, eventId)).status, 500);
            assert.equal(await StripeEvent.countDocuments({ _id: eventId }), 0);
            assert.equal((await Order.findById(order._id).lean()).paymentStatus, "PENDING");
            assert.equal(await GoogleChatDelivery.countDocuments({ orderId: order._id }), 0);
          } finally {
            failure.mock.restore();
          }
          assert.equal((await webhook(intent, undefined, eventId)).status, 200);
          assert.equal((await Order.findById(order._id).lean()).paymentStatus, "PAID");
        },
      );

      await t.test("an open Checkout blocks direct payment and is reused", async () => {
        const input = payload();
        const order = await makeOrder({ ...input, paymentAttempt: undefined });
        const first = await post(`/orders/${order._id}/checkout-session`, {});
        assert.equal(first.status, 200, JSON.stringify(first.body));
        const count = sessions.size;
        assert.equal((await post(`/orders/${order._id}/checkout-session`, {})).status, 200);
        assert.equal(sessions.size, count);
        assert.equal((await post("/orders", input)).status, 423);
      });

      await t.test("an active direct attempt blocks Checkout", async () => {
        const { order } = await saveIntent();
        assert.equal((await post(`/orders/${order._id}/checkout-session`, {})).status, 423);
      });

      await t.test(
        "Checkout confirmation preserves progress and rejects wrong totals",
        async () => {
          const order = await makeOrder({ paymentAttempt: newPaymentAttempt("CHECKOUT") });
          const result = await post(`/orders/${order._id}/checkout-session`, {});
          assert.equal(result.status, 200, JSON.stringify(result.body));
          const latest = await Order.findById(order._id).lean();
          const session = sessions.get(latest.stripeCheckoutSessionId)!;
          session.payment_status = "paid";
          session.status = "complete";
          session.payment_intent = "pi_checkout";
          await Order.updateOne({ _id: order._id }, { $set: { status: "SUBMITTED" } });
          assert.equal(
            (await post("/orders/checkout-session/confirm", { sessionId: session.id })).body.paid,
            true,
          );
          assert.equal((await Order.findById(order._id).lean()).status, "SUBMITTED");
          session.amount_total = 1;
          assert.equal(
            (await post("/orders/checkout-session/confirm", { sessionId: session.id })).status,
            409,
          );
          assert.equal((await Order.findById(order._id).lean()).amountCents, 14900);
        },
      );

      await t.test("expired Checkout permits retry only when its intent is cancelled", async () => {
        const order = await makeOrder({ paymentAttempt: newPaymentAttempt("CHECKOUT") });
        await post(`/orders/${order._id}/checkout-session`, {});
        let latest = await Order.findById(order._id).lean();
        const session = sessions.get(latest.stripeCheckoutSessionId)!;
        session.status = "expired";
        session.payment_intent = "pi_checkout_expired";
        intents.set("pi_checkout_expired", {
          id: "pi_checkout_expired",
          status: "processing",
        } as Stripe.PaymentIntent);
        assert.equal(await reconcilePayment(stripe, latest), "PENDING");
        intents.get("pi_checkout_expired")!.status = "canceled";
        assert.equal(await reconcilePayment(stripe, latest), "RETRY");
        latest = await Order.findById(order._id).lean();
        assert.equal(latest.paymentAttempt.state, "FAILED");
      });

      await t.test("confirmation winning cancellation is settled instead of retried", async () => {
        const { order } = await saveIntent();
        confirmationWinsCancellation = true;
        assert.equal(await reconcilePayment(stripe, order, true), "PAID");
        const latest = await Order.findById(order._id).lean();
        assert.equal(latest.paymentStatus, "PAID");
        assert.equal(latest.paymentAttempt.state, "SUCCEEDED");
      });

      await t.test("a delayed creator cannot overwrite a replacement attempt", async () => {
        const order = await makeOrder();
        let release!: () => void;
        createGate = new Promise((resolve) => {
          release = resolve;
        });
        const entered = new Promise<void>((resolve) => {
          onCreate = resolve;
        });
        const original = ensureDirectIntent(stripe, order);
        await entered;
        // Simulate the original worker hanging while another request recovers
        // the same empty intent, cancels it and reserves a replacement.
        createGate = undefined;
        onCreate = undefined;
        await Order.updateOne(
          { _id: order._id },
          { $set: { "paymentAttempt.startedAt": new Date(Date.now() - 120_000) } },
        );
        const recovering = await Order.findById(order._id).lean();
        assert.equal(await reconcilePayment(stripe, recovering), "RETRY");
        const failed = await Order.findById(order._id).lean();
        const next = newPaymentAttempt("DIRECT");
        await Order.findOneAndUpdate(reservationFilter(failed), {
          $set: { paymentAttempt: next, paymentStatus: "PENDING" },
          $unset: { stripePaymentIntentId: "", stripeCheckoutSessionId: "" },
        });
        release();
        await assert.rejects(original, (error: any) => error.status === 423);
        const latest = await Order.findById(order._id).lean();
        assert.equal(latest.paymentAttempt.id, next.id);
        assert.equal(latest.stripePaymentIntentId, undefined);
      });

      await t.test("lost Checkout creation recovers the same session", async () => {
        const order = await makeOrder({ paymentAttempt: newPaymentAttempt("CHECKOUT") });
        loseCheckoutCreateResponse = true;
        const before = sessions.size;
        await assert.rejects(ensureCheckoutSession(stripe, order));
        const recovered = await ensureCheckoutSession(stripe, order);
        assert.equal(sessions.size - before, 1);
        assert.equal(
          (await Order.findById(order._id).lean()).stripeCheckoutSessionId,
          recovered.id,
        );
      });

      await t.test("concurrent duplicate webhooks commit one event and one delivery", async () => {
        const { order, intent } = await saveIntent();
        intent.status = "succeeded";
        intent.amount_received = intent.amount;
        const eventId = `evt_${randomUUID()}`;
        const results = await Promise.all([
          webhook(intent, undefined, eventId),
          webhook(intent, undefined, eventId),
        ]);
        assert.ok(
          results.every((r) => r.status === 200),
          JSON.stringify(results),
        );
        assert.equal(await StripeEvent.countDocuments({ _id: eventId }), 1);
        assert.equal(await EmailOutbox.countDocuments({ orderId: order._id }), 1);
        assert.equal(
          (await Order.findById(order._id).lean()).auditEvents.filter(
            (e: any) => e.action === "payment_confirmed",
          ).length,
          1,
        );
      });

      await t.test("an expired legacy Checkout unlocks on the same request", async () => {
        const order = await makeOrder({ paymentAttempt: undefined });
        const oldSession = {
          id: `cs_${randomUUID()}`,
          amount_total: 14900,
          currency: "usd",
          livemode: false,
          metadata: { orderId: String(order._id) },
          payment_status: "unpaid",
          status: "expired",
          payment_intent: null,
        } as Stripe.Checkout.Session;
        sessions.set(oldSession.id, oldSession);
        await Order.updateOne(
          { _id: order._id },
          { $set: { stripeCheckoutSessionId: oldSession.id } },
        );
        const result = await post(`/orders/${order._id}/checkout-session`, {});
        assert.equal(result.status, 200, JSON.stringify(result.body));
        const latest = await Order.findById(order._id).lean();
        assert.notEqual(latest.stripeCheckoutSessionId, oldSession.id);
        assert.equal(latest.paymentAttempt.kind, "CHECKOUT");
      });

      await t.test("a refunded order cannot reuse an open Checkout", async () => {
        const order = await makeOrder({ paymentAttempt: newPaymentAttempt("CHECKOUT") });
        await ensureCheckoutSession(stripe, order);
        await Order.updateOne({ _id: order._id }, { $set: { paymentStatus: "REFUNDED" } });
        const result = await post(`/orders/${order._id}/checkout-session`, {});
        assert.equal(result.status, 423);
        assert.equal(result.body.clientSecret, undefined);
      });

      await t.test(
        "public summaries never expose payment fences or provider references",
        async () => {
          const { order } = await saveIntent();
          const response = await fetch(`${origin}/orders/${order._id}/summary`);
          const summary = (await response.json()) as Record<string, unknown>;
          assert.equal(summary.paymentAttempt, undefined);
          assert.equal(summary.stripePaymentIntentId, undefined);
          assert.equal(summary.stripeCheckoutSessionId, undefined);
        },
      );
    } finally {
      createGate = undefined;
      onCreate = undefined;
      confirmationGate = undefined;
      onConfirmation = undefined;
      for (const mock of mocks) mock.mock.restore();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  },
);
