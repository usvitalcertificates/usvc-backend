import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import Stripe from "stripe";
import { zohoEmail } from "./zoho-email.js";
import { EmailDispatch } from "../models/email-dispatch.js";
import { env } from "../config/env.js";
import { Order } from "../models/order.js";
import { EmailOutbox } from "../models/email-outbox.js";
import { RecoveryGrant } from "../models/recovery.js";
import { recordPayment, intentNotice, checkoutNotice } from "./payment-state.js";
import { paymentNoticeForEvent } from "./payment-events.js";
import { newPaymentAttempt, reconcilePayment } from "./payment-attempts.js";
import { processNextEmail } from "./email-outbox.js";
import { newRecoveryGrant, RECOVERY_LINK_TTL_MS } from "./recovery.js";
import { decryptSensitive } from "./crypto.js";
const uri = process.env.PAYMENT_TEST_MONGODB_URI;
test(
  "automatic recovery email transactions and delivery with mocked providers",
  { skip: !uri, timeout: 60000 },
  async (t) => {
    assert.match(uri!, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//);
    await mongoose.connect(uri!, {
      dbName: `usvc_auto_recovery_${randomUUID().replaceAll("-", "")}`,
    });
    Object.assign(env, {
      EMAIL_ENABLED: true,
      EMAIL_FROM: "USVC <support@example.test>",
      EMAIL_REPLY_TO: "support@example.test",
      ZOHO_EMAIL_API_KEY: "re_mock",
      FRONTEND_URL: "https://example.test",
      PAYMENT_ENVIRONMENT: "test",
    });
    await Promise.all([Order, EmailOutbox, RecoveryGrant].map((m) => m.init()));
    const stripe = new Stripe("sk_test_mock");
    const intents = new Map<string, any>(),
      checkouts = new Map<string, any>();
    let unavailable = false,
      providerFails = false,
      mutations = 0;
    const sent: { body: any; key: string }[] = [];
    t.mock.method(Object.getPrototypeOf(stripe.paymentIntents), "retrieve", async (id: string) => {
      if (unavailable) throw Error("Unavailable secret must not be logged");
      return structuredClone(intents.get(id));
    });
    t.mock.method(
      Object.getPrototypeOf(stripe.checkout.sessions),
      "retrieve",
      async (id: string) => {
        if (unavailable) throw Error("Unavailable");
        return structuredClone(checkouts.get(id));
      },
    );
    t.mock.method(Object.getPrototypeOf(stripe.paymentIntents), "cancel", async (id: string) => {
      mutations++;
      intents.get(id).status = "canceled";
      return structuredClone(intents.get(id));
    });
    for (const method of ["create", "confirm"] as const)
      t.mock.method(Object.getPrototypeOf(stripe.paymentIntents), method, async () => {
        mutations++;
        throw Error("Unexpected mutation");
      });
    t.mock.method(zohoEmail, "send", async (body: any, opts: any) => {
      sent.push({ body, key: opts });
      return providerFails
        ? { kind: "rejected", retryable: true, code: "ZOHO_RATE_LIMIT" }
        : { kind: "accepted", messageId: "mock_email" };
    });
    const make = async (kind: "DIRECT" | "CHECKOUT" = "DIRECT", eligible = true) => {
      const attempt = {
        ...newPaymentAttempt(kind),
        state: "FAILED",
        ...(eligible ? {} : { recoveryEmailEligible: undefined }),
      };
      const id = new mongoose.Types.ObjectId(),
        intentId = `pi_${randomUUID()}`;
      const order = await Order.create({
        _id: id,
        publicNumber: `TEST-${randomUUID()}`,
        stateSlug: "florida",
        stateName: "Florida",
        stateCode: "FL",
        certificate: "BIRTH",
        geo: { county: "Orange", city: "Orlando" },
        reason: "Passport",
        applicant: {
          firstName: "Jane",
          lastName: "Example",
          relationship: "Self",
          phone: "+15550100100",
          email: "jane@example.test",
        },
        copies: 1,
        consents: {
          accurate: true,
          govtId: true,
          terms: true,
          privacy: true,
          refund: true,
          processingPayment: true,
        },
        signature: "Jane Example",
        pricing: { serviceCents: 14900, rushCents: 0, totalCents: 14900 },
        amountCents: 14900,
        currency: "usd",
        paymentStatus: "PENDING",
        paymentAttempt: attempt,
        stripePaymentIntentId: intentId,
        ...(kind === "CHECKOUT" ? { stripeCheckoutSessionId: `cs_${randomUUID()}` } : {}),
      });
      const intent = {
        id: intentId,
        metadata: { orderId: String(id), paymentAttemptId: attempt.id },
        amount: 14900,
        amount_received: 0,
        currency: "usd",
        livemode: false,
        status: "canceled",
        last_payment_error: { code: "card_declined" },
      };
      intents.set(intentId, intent);
      if (kind === "CHECKOUT")
        checkouts.set(order.stripeCheckoutSessionId, {
          id: order.stripeCheckoutSessionId,
          metadata: intent.metadata,
          amount_total: 14900,
          currency: "usd",
          livemode: false,
          payment_intent: intentId,
          payment_status: "unpaid",
          status: "expired",
        });
      return {
        order,
        intent,
        notice: {
          ...(kind === "CHECKOUT"
            ? checkoutNotice(checkouts.get(order.stripeCheckoutSessionId))
            : intentNotice(intent as any)),
          confirmedFailure: true,
        },
      };
    };
    const job = (id: unknown) =>
      EmailOutbox.findById(`payment_recovery_${id}`)
        .select("+recoverySecret +recoveryContent")
        .lean();
    const due = (id: unknown) =>
      EmailOutbox.updateOne(
        { _id: `payment_recovery_${id}` },
        { $set: { nextAttemptAt: new Date(0) } },
      );
    const clean = async () => {
      await EmailOutbox.deleteMany({});
      await EmailDispatch.deleteMany({});
      sent.length = 0;
      unavailable = providerFails = false;
    };
    try {
      await t.test(
        "concurrent failures queue once, delay two minutes, and cannot requeue after TTL",
        async () => {
          const { order, notice } = await make();
          await Promise.all([recordPayment(notice), recordPayment(notice), recordPayment(notice)]);
          let row = await job(order._id);
          assert.ok(row);
          assert.equal(row.nextAttemptAt.getTime() - row.recoveryScheduledAt.getTime(), 120000);
          assert.equal(await processNextEmail(), false);
          assert.equal(await RecoveryGrant.countDocuments(), 0);
          await due(order._id);
          await processNextEmail();
          row = await job(order._id);
          assert.equal(row.status, "SENT");
          assert.equal(row.recoverySecret, undefined);
          assert.equal(sent.length, 1);
          assert.equal(
            sent[0].key,
            (await EmailDispatch.findById(`payment_recovery_${order._id}`).lean()).reference,
          );
          assert.match(sent[0].key, /^[a-f0-9]{64}$/);
          const grant = await RecoveryGrant.findById(row.recoveryGrantId)
            .select("+tokenHash")
            .lean();
          assert.equal(grant.source, "AUTOMATIC");
          assert.equal(String(grant.orderId), String(order._id));
          assert.ok(
            Math.abs(grant.expiresAt.getTime() - grant.createdAt.getTime() - RECOVERY_LINK_TTL_MS) <
              1000,
          );
          assert.equal(
            (await Order.findById(order._id).lean()).paymentRecoveryEmail.outcome,
            "SENT",
          );
          assert.equal(mutations, 0);
          await EmailOutbox.deleteMany({});
          await EmailDispatch.deleteMany({});
          await recordPayment(notice);
          assert.equal(await job(order._id), null);
        },
      );
      await clean();
      await t.test(
        "outbox failures roll back both guarded failure and permanent notification marker",
        async () => {
          const { order, notice } = await make();
          const failedInsert = t.mock.method(EmailOutbox, "create", async () => {
            throw new Error("Synthetic database interruption");
          });
          await assert.rejects(recordPayment(notice), /Synthetic database interruption/);
          failedInsert.mock.restore();
          const rolledBack = await Order.findById(order._id).lean();
          assert.equal(rolledBack.paymentStatus, "PENDING");
          assert.equal(rolledBack.paymentRecoveryEmail, undefined);
          await recordPayment(notice);
          assert.ok(await job(order._id));
          await clean();
        },
      );
      await t.test(
        "provider retry and reclaimed lease reuse encrypted link and expiry",
        async () => {
          const { order, notice } = await make();
          await recordPayment(notice);
          await due(order._id);
          providerFails = true;
          await processNextEmail();
          const first = await job(order._id);
          assert.ok(first.recoverySecret);
          assert.doesNotMatch(first.recoverySecret, /resume#/);
          const token = decryptSensitive(first.recoverySecret);
          assert.ok(sent[0].body.text.includes(`/resume-florida-birth-certificate#${token}`));
          assert.equal(first.lastError, "Recovery email delivery failed");
          await EmailOutbox.updateOne(
            { _id: first._id },
            { $set: { status: "SENDING", leaseExpiresAt: new Date(0) } },
          );
          await Order.updateOne(
            { _id: order._id },
            { $set: { "applicant.firstName": "Changed after provider attempt" } },
          );
          providerFails = false;
          await processNextEmail();
          const next = await job(order._id);
          assert.equal(String(next.recoveryGrantId), String(first.recoveryGrantId));
          assert.equal(next.recoveryExpiresAt.getTime(), first.recoveryExpiresAt.getTime());
          assert.deepEqual(sent[0], sent[1]);
          assert.equal(next.recoverySecret, undefined);
          assert.equal(next.recoveryContent, undefined);
        },
      );
      await clean();
      await t.test(
        "paid, refunded, cancelled, and Stripe-only successes suppress delivery",
        async () => {
          for (const variant of ["PAID", "REFUNDED", "CANCELLED", "STRIPE_PAID"]) {
            const { order, intent, notice } = await make();
            await recordPayment(notice);
            if (variant === "STRIPE_PAID") {
              intent.status = "succeeded";
              intent.amount_received = intent.amount;
            } else
              await Order.updateOne(
                { _id: order._id },
                {
                  $set: variant === "CANCELLED" ? { status: variant } : { paymentStatus: variant },
                },
              );
            await due(order._id);
            await processNextEmail();
            assert.equal((await job(order._id)).status, "SKIPPED");
          }
          assert.equal(sent.length, 0);
        },
      );
      await clean();
      await t.test(
        "uncertain attempts and outages defer without consuming provider retries, then stop after 48 hours",
        async () => {
          const { order, intent, notice } = await make();
          await recordPayment(notice);
          intent.status = "processing";
          await due(order._id);
          await processNextEmail();
          assert.equal((await job(order._id)).attempts, 0);
          unavailable = true;
          await due(order._id);
          await processNextEmail();
          assert.equal((await job(order._id)).status, "PENDING");
          await EmailOutbox.updateOne(
            { _id: `payment_recovery_${order._id}` },
            {
              $set: {
                recoveryScheduledAt: new Date(Date.now() - RECOVERY_LINK_TTL_MS - 1),
                nextAttemptAt: new Date(0),
              },
            },
          );
          await processNextEmail();
          assert.equal((await job(order._id)).status, "SKIPPED");
          assert.equal((await Order.findById(order._id).lean()).paymentStatus, "FAILED");
          assert.equal(sent.length, 0);
        },
      );
      await clean();
      await t.test(
        "old attempts, stale/mismatched notices, uncertainty, and email-disabled environments never schedule",
        async () => {
          const old = await make("DIRECT", false);
          await recordPayment(old.notice);
          assert.equal(await job(old.order._id), null);
          const fresh = await make();
          for (const n of [
            { ...fresh.notice, confirmedFailure: false },
            { ...fresh.notice, attemptId: "old" },
            { ...fresh.notice, amountCents: 1 },
            { ...fresh.notice, currency: "eur" },
            { ...fresh.notice, intentId: "pi_wrong" },
          ])
            await recordPayment(n);
          assert.equal(await job(fresh.order._id), null);
          env.EMAIL_ENABLED = false;
          await recordPayment(fresh.notice);
          assert.equal(await job(fresh.order._id), null);
          env.EMAIL_ENABLED = true;
        },
      );
      await clean();
      await t.test(
        "Checkout validated failures schedule and direct reconciliation recovers a crash before failure recording",
        async () => {
          const checkout = await make("CHECKOUT");
          checkout.intent.status = "requires_payment_method";
          const event = {
            type: "checkout.session.async_payment_failed",
            created: Math.floor(Date.now() / 1000),
            data: { object: checkouts.get(checkout.order.stripeCheckoutSessionId) },
          } as Stripe.Event;
          const notice = await paymentNoticeForEvent(stripe, event);
          assert.ok(notice?.confirmedFailure);
          await recordPayment(notice);
          await due(checkout.order._id);
          await processNextEmail();
          assert.equal((await job(checkout.order._id)).status, "SENT");
          const direct = await make();
          direct.intent.status = "requires_payment_method";
          await Order.updateOne(
            { _id: direct.order._id },
            { $set: { "paymentAttempt.state": "CONFIRMING" } },
          );
          assert.equal(
            await reconcilePayment(stripe, await Order.findById(direct.order._id).lean(), true),
            "RETRY",
          );
          assert.ok(await job(direct.order._id));
        },
      );
      await clean();
      await t.test(
        "permanent provider failure redacts delivery secrets and records outcome",
        async () => {
          const { order, notice } = await make();
          await recordPayment(notice);
          await due(order._id);
          providerFails = true;
          await processNextEmail(); // Explicit rejection creates safe retry evidence.
          await EmailOutbox.updateOne(
            { _id: `payment_recovery_${order._id}` },
            { $set: { attempts: 9, nextAttemptAt: new Date(0) } },
          );
          await processNextEmail();
          const row = await job(order._id);
          assert.equal(row.status, "FAILED");
          assert.equal(row.recoverySecret, undefined);
          assert.equal(
            (await Order.findById(order._id).lean()).paymentRecoveryEmail.outcome,
            "FAILED",
          );
        },
      );
      await clean();
      await t.test("expired outbox cleanup leaves a permanent skipped marker", async () => {
        const { order, notice } = await make();
        await recordPayment(notice);
        await Order.updateOne(
          { _id: order._id },
          {
            $set: {
              "paymentRecoveryEmail.scheduledAt": new Date(Date.now() - RECOVERY_LINK_TTL_MS - 1),
            },
          },
        );
        await EmailOutbox.deleteOne({ _id: `payment_recovery_${order._id}` });
        await processNextEmail();
        assert.equal(
          (await Order.findById(order._id).lean()).paymentRecoveryEmail.outcome,
          "SKIPPED",
        );
        await recordPayment(notice);
        assert.equal(await job(order._id), null);
      });
      await t.test(
        "all new grant sources use 48 hours and old stored expiries stay unchanged",
        async () => {
          for (const source of ["SELF", "STAFF", "AUTOMATIC"] as const) {
            const result = await newRecoveryGrant("jane@example.test", source);
            assert.ok(
              Math.abs(result.expiresAt.getTime() - Date.now() - RECOVERY_LINK_TTL_MS) < 1000,
            );
          }
          const old = await RecoveryGrant.create({
            email: "jane@example.test",
            source: "STAFF",
            tokenHash: randomUUID(),
            expiresAt: new Date(Date.now() + 7 * 86400000),
          });
          assert.equal(
            (await RecoveryGrant.findById(old._id).lean()).expiresAt.getTime(),
            old.expiresAt.getTime(),
          );
        },
      );
    } finally {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  },
);
