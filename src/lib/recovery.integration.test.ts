import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import mongoose from "mongoose";
import Stripe from "stripe";
import jwt from "jsonwebtoken";
import { app } from "../app.js";
import { env } from "../config/env.js";
import { Order } from "../models/order.js";
import { StaffUser } from "../models/staff.js";
import { EmailOutbox } from "../models/email-outbox.js";
import {
  RecoveryGrant,
  RecoveryChallenge,
  RecoverySession,
  RecoveryLimit,
  RecoveryAudit,
} from "../models/recovery.js";
import { newRecoveryGrant, RECOVERY_MESSAGE } from "./recovery.js";
import { encryptSensitive, decryptSensitive } from "./crypto.js";
import { newPaymentAttempt } from "./payment-attempts.js";
import { processNextEmail } from "./email-outbox.js";
import { Resend } from "resend";
const uri = process.env.PAYMENT_TEST_MONGODB_URI;
test(
  "secure application recovery with real Mongo and mocked Stripe/email",
  { skip: !uri, timeout: 60000 },
  async (t) => {
    assert.match(uri!, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//);
    await mongoose.connect(uri!, {
      dbName: `usvc_recovery_test_${randomUUID().replaceAll("-", "")}`,
    });
    Object.assign(env, {
      EMAIL_ENABLED: true,
      FRONTEND_URL: "http://localhost:3141",
      EMAIL_FROM: "USVC <support@example.test>",
      EMAIL_REPLY_TO: "support@example.test",
      RESEND_API_KEY: "re_local",
      NODE_ENV: "test",
      PAYMENT_ENVIRONMENT: "test",
      ANALYTICS_ENABLED: false,
      OPENAI_CONVERSIONS_ENABLED: false,
    });
    await Promise.all(
      [
        Order,
        StaffUser,
        EmailOutbox,
        RecoveryGrant,
        RecoveryChallenge,
        RecoverySession,
        RecoveryLimit,
        RecoveryAudit,
      ].map((m) => m.init()),
    );
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as { port: number };
    const origin = `http://127.0.0.1:${address.port}`;
    const call = async (
      path: string,
      body?: unknown,
      cookie?: string,
      method = "POST",
      extra: Record<string, string> = {},
    ) => {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          origin: env.FRONTEND_URL,
          ...(cookie ? { cookie } : {}),
          ...extra,
        },
        ...(method !== "GET" ? { body: JSON.stringify(body ?? {}) } : {}),
      });
      return {
        status: response.status,
        body: (await response.json()) as any,
        cookie: response.headers.get("set-cookie"),
        headers: response.headers,
      };
    };
    const payload = () => ({
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
        lastName: "Example",
        dateOfBirth: "1990-05-20",
        phone: "+15550100100",
        email: "recovery@example.test",
      },
      subject: {
        firstName: "Baby",
        lastName: "Example",
        eventDate: "2020-01-15",
        sex: "Female",
        subjectMaidenLastName: "Example",
        stillLiving: "Yes",
      },
      family: {
        motherFirstName: "Jane",
        motherCurrentLastName: "Example",
        motherLastName: "Smith",
        fatherStatus: "Unknown",
      },
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
      signature: "Jane Example",
      totalCents: 14900,
    });
    let seq = 0;
    const make = async (extra: Record<string, unknown> = {}) => {
      const input = payload();
      return Order.create({
        ...input,
        publicNumber: `RECOVERY-${++seq}`,
        geo: { county: input.county, city: input.city },
        pricing: { serviceCents: 14900, rushCents: 0, totalCents: 14900 },
        amountCents: 14900,
        currency: "usd",
        status: "AWAITING_PAYMENT",
        paymentStatus: "FAILED",
        confidentialData: { ssnEnc: encryptSensitive("123-45-6789") },
        ...extra,
      });
    };
    const login = async (orderId?: unknown, email = "recovery@example.test") => {
      const { token, grant } = await newRecoveryGrant(email, orderId ? "STAFF" : "SELF", orderId);
      const sent = await call("/recovery/code", { token });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      const job = await EmailOutbox.findOne({
        recoveryGrantId: grant._id,
        template: "RECOVERY_CODE",
      })
        .select("+recoverySecret")
        .lean();
      const code = decryptSensitive(job!.recoverySecret!);
      const result = await call("/recovery/verify", { token, code });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return { token, grant, code, cookie: result.cookie!.split(";")[0] };
    };
    const stripe = new Stripe("sk_test_local"),
      intents = new Map<string, any>();
    let confirmations = 0,
      decline = false,
      unavailable = false;
    let gate: Promise<void> | undefined;
    let started: () => void = () => {};
    t.mock.method(Object.getPrototypeOf(stripe.paymentIntents), "create", async (args: any) => {
      const id = `pi_${randomUUID()}`;
      const v = {
        id,
        amount: args.amount,
        amount_received: 0,
        currency: args.currency,
        metadata: args.metadata,
        livemode: false,
        status: "requires_payment_method",
      };
      intents.set(id, v);
      return v;
    });
    t.mock.method(Object.getPrototypeOf(stripe.paymentIntents), "confirm", async (id: string) => {
      confirmations++;
      started();
      await gate;
      const intent = intents.get(id);
      if (decline) {
        intent.status = "requires_payment_method";
        throw Object.assign(new Error("Declined"), {
          type: "StripeCardError",
          code: "card_declined",
        });
      }
      intent.status = "succeeded";
      intent.amount_received = intent.amount;
      return intent;
    });
    t.mock.method(Object.getPrototypeOf(stripe.paymentIntents), "retrieve", async (id: string) => {
      if (unavailable) throw new Error("Unavailable");
      return intents.get(id);
    });
    t.mock.method(Object.getPrototypeOf(stripe.paymentIntents), "cancel", async (id: string) => {
      const v = intents.get(id);
      v.status = "canceled";
      return v;
    });
    const sentEmails: Record<string, unknown>[] = [];
    let emailFails = false;
    t.mock.method(
      Object.getPrototypeOf(new Resend("re_local").emails),
      "send",
      async (args: Record<string, unknown>) => {
        sentEmails.push(args);
        return emailFails
          ? { error: { message: "sensitive-provider-response" } }
          : { data: { id: "synthetic-email" }, error: null };
      },
    );
    try {
      await make({ publicNumber: "RECOVERY-SECOND" });
      const order = await make(),
        other = await make({
          applicant: { ...payload().applicant, email: "someone-else@example.test" },
        }),
        refunded = await make({ paymentStatus: "REFUNDED" });
      await t.test(
        "neutral requests, email-only matches, encrypted delivery and no scanner effects",
        async () => {
          const before = await EmailOutbox.countDocuments();
          const unknown = await call("/recovery/request", { email: "unknown@example.test" });
          const known = await call("/recovery/request", { email: "RECOVERY@example.test" });
          assert.equal(known.status, 200);
          assert.deepEqual(known.body, unknown.body);
          assert.equal(known.body.message, RECOVERY_MESSAGE);
          assert.equal(await EmailOutbox.countDocuments(), before + 1);
          const job = await EmailOutbox.findOne({ template: "RECOVERY_LINK" })
            .select("+recoverySecret")
            .lean();
          assert.ok(job!.recoverySecret!.startsWith("v1."));
          assert.equal(await RecoveryChallenge.countDocuments(), 0);
          assert.equal(
            (await call("/recovery/applications", undefined, undefined, "GET")).status,
            401,
          );
          assert.equal(
            (
              await call(
                "/recovery/request",
                { email: "recovery@example.test" },
                undefined,
                "POST",
                { origin: "https://evil.test" },
              )
            ).status,
            403,
          );
        },
      );
      const verified = await login();
      await t.test("verification is one-use and limits disclosure to verified email", async () => {
        assert.equal(
          (await call("/recovery/verify", { token: verified.token, code: verified.code })).status,
          400,
        );
        assert.equal((await call("/recovery/code", { token: verified.token })).status, 429);
        const list = await call("/recovery/applications", undefined, verified.cookie, "GET");
        assert.equal(list.headers.get("cache-control"), "no-store");
        assert.equal(list.body.applications.length, 2);
        assert.equal(
          (await call(`/recovery/applications/${other._id}`, undefined, verified.cookie, "GET"))
            .status,
          404,
        );
        const detail = await call(
          `/recovery/applications/${order._id}`,
          undefined,
          verified.cookie,
          "GET",
        );
        const serialized = JSON.stringify(detail.body);
        assert.ok(
          !serialized.includes("ssnEnc") &&
            !serialized.includes("123-45-6789") &&
            !serialized.includes("cardNumber"),
        );
        assert.equal(detail.body.hasStoredSsn, true);
      });
      await t.test("invalid, expired and exhausted codes never create sessions", async () => {
        const { token, grant } = await newRecoveryGrant("badcodes@example.test", "SELF");
        await call("/recovery/code", { token });
        const before = await RecoverySession.countDocuments();
        for (let i = 0; i < 6; i++)
          assert.equal((await call("/recovery/verify", { token, code: "000000" })).status, 400);
        assert.equal(await RecoverySession.countDocuments(), before);
        assert.equal((await RecoveryChallenge.findOne({ grantId: grant._id }).lean())!.attempts, 5);
        await RecoveryGrant.updateOne({ _id: grant._id }, { $set: { expiresAt: new Date(0) } });
        assert.equal((await call("/recovery/code", { token })).status, 410);
      });
      await t.test(
        "edits preserve encrypted SSN and attribution, reject stale revisions and fixed-field changes",
        async () => {
          const before = await Order.findById(order._id).lean();
          const input = payload();
          input.applicant.firstName = "Janet";
          const updated = await call(
            `/recovery/applications/${order._id}`,
            { revision: 0, application: input },
            verified.cookie,
            "PATCH",
          );
          assert.equal(updated.status, 200, JSON.stringify(updated.body));
          assert.equal(updated.body.revision, 1);
          const after = await Order.findById(order._id).lean();
          assert.equal(after.confidentialData.ssnEnc, before.confidentialData.ssnEnc);
          assert.equal(
            (
              await call(
                `/recovery/applications/${order._id}`,
                { revision: 0, application: input },
                verified.cookie,
                "PATCH",
              )
            ).status,
            409,
          );
          assert.equal(
            (
              await call(
                `/recovery/applications/${order._id}`,
                { revision: 1, application: { ...input, stateCode: "NY" } },
                verified.cookie,
                "PATCH",
              )
            ).status,
            422,
          );
        },
      );
      await t.test(
        "decline permits same-order retry; simultaneous submissions confirm once",
        async () => {
          const input = {
            ...payload(),
            paymentCard: { number: "4111111111111111", expiry: "12/30", securityCode: "123" },
            stripeCardToken: "tok_test",
          };
          decline = true;
          const failed = await call(
            `/recovery/applications/${order._id}/pay`,
            { revision: 1, application: input },
            verified.cookie,
          );
          assert.equal(failed.status, 402, JSON.stringify(failed.body));
          assert.equal(failed.body.publicNumber, order.publicNumber);
          const automatic = await EmailOutbox.findById(`payment_recovery_${order._id}`).lean();
          assert.equal(automatic?.template, "PAYMENT_RECOVERY");
          assert.equal(
            automatic.nextAttemptAt.getTime() - automatic.recoveryScheduledAt.getTime(),
            120000,
          );
          decline = false;
          let release!: () => void;
          gate = new Promise<void>((r) => {
            release = r;
          });
          const ready = new Promise<void>((r) => {
            started = r;
          });
          const first = call(
            `/recovery/applications/${order._id}/pay`,
            { revision: 2, application: input },
            verified.cookie,
          );
          await ready;
          const second = await call(
            `/recovery/applications/${order._id}/pay`,
            { revision: 2, application: input },
            verified.cookie,
          );
          assert.equal(second.status, 423);
          release();
          gate = undefined;
          const result = await first;
          assert.equal(result.status, 201, JSON.stringify(result.body));
          assert.equal(result.body.id, String(order._id));
          assert.equal(confirmations, 2);
          assert.equal(
            await EmailOutbox.countDocuments({
              template: "PAYMENT_CONFIRMATION",
              orderId: order._id,
            }),
            1,
          );
          assert.equal(
            (
              await call(
                `/recovery/applications/${order._id}`,
                { revision: 3, application: payload() },
                verified.cookie,
                "PATCH",
              )
            ).status,
            409,
          );
        },
      );
      await t.test("unresolved legacy and active attempts block edits and charges", async () => {
        for (const extra of [
          { chargeAttempts: 1 },
          { paymentAttempt: newPaymentAttempt("DIRECT") },
        ]) {
          const blocked = await make(extra);
          const session = await login(blocked._id);
          const result = await call(
            `/recovery/applications/${blocked._id}`,
            { revision: 0, application: payload() },
            session.cookie,
            "PATCH",
          );
          assert.equal(result.status, 423, JSON.stringify(result.body));
        }
      });
      await t.test(
        "staff roles, replacement revocation, expiry and refunded protection",
        async () => {
          await RecoveryLimit.deleteMany({});
          const starting = await make();
          let link = "";
          for (const role of ["FULFILLMENT", "ADMIN", "CS"]) {
            const staff = await StaffUser.create({
              email: `${role.toLowerCase()}@example.test`,
              passwordHash: "unused",
              role,
              accountStatus: "active",
            });
            const authorization = `Bearer ${jwt.sign({ sub: String(staff._id), role }, env.JWT_ACCESS_SECRET, { expiresIn: "5m" })}`;
            const generated = await call(
              `/staff/unpaid-orders/${starting._id}/resume-link`,
              {},
              undefined,
              "POST",
              { authorization },
            );
            assert.equal(
              generated.status,
              role === "FULFILLMENT" ? 403 : 200,
              JSON.stringify(generated.body),
            );
            if (role === "ADMIN") {
              link = generated.body.url;
              const token = link.split("#")[1];
              await call("/recovery/code", { token });
              const job = await EmailOutbox.findOne({
                template: "RECOVERY_CODE",
                recoveryGrantId: (await RecoveryGrant.findOne({
                  orderId: starting._id,
                  revokedAt: { $exists: false },
                }).lean())!._id,
              })
                .select("+recoverySecret")
                .lean();
              const verifiedResult = await call("/recovery/verify", {
                token,
                code: decryptSensitive(job!.recoverySecret!),
              });
              (starting as any).cookie = verifiedResult.cookie!.split(";")[0];
            }
            if (role === "CS") {
              assert.equal(
                (await call("/recovery/code", { token: link.split("#")[1] })).status,
                410,
              );
              assert.equal(
                (await call("/recovery/applications", undefined, (starting as any).cookie, "GET"))
                  .status,
                401,
              );
            }
            assert.equal(
              (
                await call(
                  `/staff/unpaid-orders/${refunded._id}/resume-link`,
                  {},
                  undefined,
                  "POST",
                  { authorization },
                )
              ).status,
              role === "FULFILLMENT" ? 403 : 409,
            );
            await StaffUser.updateOne({ _id: staff._id }, { $set: { accountStatus: "disabled" } });
            assert.equal(
              (
                await call(
                  `/staff/unpaid-orders/${starting._id}/resume-link`,
                  {},
                  undefined,
                  "POST",
                  { authorization },
                )
              ).status,
              403,
            );
          }
          await RecoveryLimit.deleteMany({});
          const expired = await login(starting._id);
          await RecoverySession.updateMany(
            { grantId: expired.grant._id },
            { $set: { expiresAt: new Date(0) } },
          );
          assert.equal(
            (await call("/recovery/applications", undefined, expired.cookie, "GET")).status,
            401,
          );
          const refundSession = await login(refunded._id);
          assert.equal(
            (
              await call(
                `/recovery/applications/${refunded._id}`,
                undefined,
                refundSession.cookie,
                "GET",
              )
            ).status,
            409,
          );
        },
      );
      await t.test("Stripe outages stay uncertain and cannot create another charge", async () => {
        await RecoveryLimit.deleteMany({});
        const blocked = await make({
          paymentAttempt: newPaymentAttempt("DIRECT"),
          stripePaymentIntentId: "pi_unavailable",
        });
        const member = await login(blocked._id);
        unavailable = true;
        const before = confirmations;
        const status = await call(
          `/recovery/applications/${blocked._id}/status`,
          {},
          member.cookie,
        );
        assert.equal(status.status, 423);
        const payment = await call(
          `/recovery/applications/${blocked._id}/pay`,
          {
            revision: 0,
            application: {
              ...payload(),
              paymentCard: { number: "4111111111111111", expiry: "12/30", securityCode: "123" },
            },
          },
          member.cookie,
        );
        assert.equal(payment.status, 423);
        assert.equal(confirmations, before);
        unavailable = false;
      });
      await t.test(
        "pagination cannot expand an order-scoped grant; revoked staff and signed-out callers are denied",
        async () => {
          await RecoveryLimit.deleteMany({});
          const only = await make();
          const scoped = await login(only._id);
          const list = await call(
            "/recovery/applications?after=ffffffffffffffffffffffff",
            undefined,
            scoped.cookie,
            "GET",
          );
          assert.equal(list.status, 200);
          assert.equal(list.body.applications.length, 1);
          assert.equal(list.body.applications[0].id, String(only._id));
          const staff = await StaffUser.create({
            email: "revoked@example.test",
            passwordHash: "unused",
            role: "CS",
            accountStatus: "active",
            sessionsRevokedAt: new Date(Date.now() + 1000),
          });
          const authorization = `Bearer ${jwt.sign({ sub: String(staff._id), role: "CS" }, env.JWT_ACCESS_SECRET, { expiresIn: "5m" })}`;
          assert.equal(
            (
              await call(`/staff/unpaid-orders/${only._id}/resume-link`, {}, undefined, "POST", {
                authorization,
              })
            ).status,
            401,
          );
          assert.equal(
            (await call(`/staff/unpaid-orders/${only._id}/resume-link`, {})).status,
            401,
          );
        },
      );
      await t.test("long lists paginate without dropping applications", async () => {
        await RecoveryLimit.deleteMany({});
        const member = await login(undefined, "many@example.test");
        for (let i = 0; i < 27; i++)
          await make({ applicant: { ...payload().applicant, email: "many@example.test" } });
        const first = await call("/recovery/applications", undefined, member.cookie, "GET");
        assert.equal(first.body.applications.length, 25);
        assert.ok(first.body.nextCursor);
        const second = await call(
          `/recovery/applications?after=${first.body.nextCursor}`,
          undefined,
          member.cookie,
          "GET",
        );
        assert.equal(second.body.applications.length, 2);
        assert.equal(second.body.nextCursor, null);
        assert.equal(
          new Set([...first.body.applications, ...second.body.applications].map((v: any) => v.id))
            .size,
          27,
        );
      });
      await t.test(
        "email delivery uses encrypted secrets, strips sent payloads and hides provider errors",
        async () => {
          await EmailOutbox.updateMany(
            {},
            { $set: { status: "SENT" }, $unset: { recoverySecret: 1 } },
          );
          const grant = await newRecoveryGrant("delivery@example.test", "SELF");
          await EmailOutbox.create({
            _id: "delivery-success",
            recipient: "delivery@example.test",
            template: "RECOVERY_LINK",
            recoveryGrantId: grant.grant._id,
            recoverySecret: encryptSensitive(grant.token),
            recoveryExpiresAt: grant.expiresAt,
          });
          assert.equal(await processNextEmail(), true);
          assert.ok(String(sentEmails.at(-1)!.html).includes(`/resume#${grant.token}`));
          const sent = await EmailOutbox.findById("delivery-success")
            .select("+recoverySecret")
            .lean();
          assert.equal(sent!.status, "SENT");
          assert.equal(sent!.recoverySecret, undefined);
          emailFails = true;
          await EmailOutbox.create({
            _id: "delivery-failure",
            recipient: "delivery@example.test",
            template: "RECOVERY_CODE",
            recoveryGrantId: grant.grant._id,
            recoveryChallengeId: (
              await RecoveryChallenge.create({
                grantId: grant.grant._id,
                codeHash: "unused",
                expiresAt: new Date(Date.now() + 600000),
              })
            )._id,
            recoverySecret: encryptSensitive("123456"),
            recoveryExpiresAt: new Date(Date.now() + 600000),
          });
          await processNextEmail();
          const failed = await EmailOutbox.findById("delivery-failure").lean();
          assert.equal(failed!.lastError, "Recovery email delivery failed");
          assert.equal(failed!.status, "PENDING");
          emailFails = false;
        },
      );
      await t.test(
        "saved unpaid copies are repriced on a safe retry and historical counts require correction",
        async () => {
          await RecoveryLimit.deleteMany({});
          const saved = await make({
            copies: 9,
            amountCents: 134100,
            pricing: { serviceCents: 134100, rushCents: 0, totalCents: 134100 },
          });
          await Order.updateOne({ _id: saved._id }, { $set: { copies: 20 } });
          const authenticated = await login(saved._id);
          const detail = await call(
            `/recovery/applications/${saved._id}`,
            undefined,
            authenticated.cookie,
            "GET",
          );
          assert.equal(detail.body.copies, 20);
          const application = {
            ...payload(),
            copies: 20,
            totalCents: 147900,
            paymentCard: { number: "4111111111111111", expiry: "12/30", securityCode: "123" },
            stripeCardToken: "tok_test",
          };
          const invalid = await call(
            `/recovery/applications/${saved._id}/pay`,
            { revision: 0, application },
            authenticated.cookie,
          );
          assert.equal(invalid.status, 400);
          assert.equal((await Order.findById(saved._id).lean()).amountCents, 134100);
          const paid = await call(
            `/recovery/applications/${saved._id}/pay`,
            { revision: 0, application: { ...application, copies: 9, totalCents: 70900 } },
            authenticated.cookie,
          );
          assert.equal(paid.status, 201, JSON.stringify(paid.body));
          const latest = await Order.findById(saved._id).lean();
          assert.equal(latest.amountCents, 70900);
          assert.equal(latest.copies, 9);
          assert.equal(latest.paymentStatus, "PAID");
        },
      );
      await t.test(
        "historical paid quantities and stored pricing survive fulfillment saves",
        async () => {
          const paid = await make({ paymentStatus: "PAID", status: "PAID" });
          await Order.updateOne(
            { _id: paid._id },
            {
              $set: {
                copies: 20,
                amountCents: 298000,
                pricing: { serviceCents: 298000, rushCents: 0, totalCents: 298000 },
              },
            },
          );
          const legacy = await Order.findById(paid._id);
          legacy.status = "IN_REVIEW";
          await legacy.save();
          const latest = await Order.findById(paid._id).lean();
          assert.equal(latest.copies, 20);
          assert.equal(latest.amountCents, 298000);
          const invalid = await make();
          invalid.copies = 10;
          await assert.rejects(invalid.validate(), /between 1 and 9 copies/);
        },
      );
      await t.test(
        "email throttling is shared and email-disabled recovery is unavailable",
        async () => {
          await RecoveryLimit.deleteMany({});
          for (let i = 0; i < 3; i++)
            assert.equal(
              (await call("/recovery/request", { email: "throttle@example.test" })).status,
              200,
            );
          assert.equal(
            (await call("/recovery/request", { email: "throttle@example.test" })).body.message,
            RECOVERY_MESSAGE,
          );
          assert.equal(await RecoveryLimit.countDocuments(), 2);
          env.EMAIL_ENABLED = false;
          assert.equal(
            (await call("/recovery/request", { email: "recovery@example.test" })).status,
            503,
          );
          env.EMAIL_ENABLED = true;
        },
      );
      await t.test("email worker removes expired secrets without sending", async () => {
        await EmailOutbox.updateMany(
          {},
          { $set: { status: "SENT" }, $unset: { recoverySecret: 1 } },
        );
        const grant = await newRecoveryGrant("expired@example.test", "SELF");
        await EmailOutbox.create({
          _id: "expired-recovery",
          recipient: "expired@example.test",
          template: "RECOVERY_LINK",
          recoveryGrantId: grant.grant._id,
          recoverySecret: encryptSensitive(grant.token),
          recoveryExpiresAt: new Date(0),
        });
        await processNextEmail();
        assert.equal(
          (await EmailOutbox.findById("expired-recovery").select("+recoverySecret").lean())!
            .recoverySecret,
          undefined,
        );
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  },
);
