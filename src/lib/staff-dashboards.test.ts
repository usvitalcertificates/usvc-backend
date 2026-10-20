import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import Stripe from "stripe";
import { app } from "../app.js";
import { env } from "../config/env.js";
import { Order } from "../models/order.js";
import { StaffUser } from "../models/staff.js";
import { StaffAccessAudit } from "../models/staff-access-audit.js";
import { stripePaymentSearch, stripeSearchSchema } from "./stripe-history.js";
import { dateOnly } from "./staff-dashboards.js";

test("dashboard date validation rejects impossible dates and reversed ranges", () => {
  assert.equal(dateOnly.safeParse("2026-02-30").success, false);
  assert.equal(dateOnly.safeParse("2026-02-28").success, true);
  assert.equal(
    stripeSearchSchema.safeParse({ from: "2026-10-20", to: "2026-10-01" }).success,
    false,
  );
});
const uri = process.env.DASHBOARD_TEST_MONGODB_URI;
test(
  "staff dashboards with real MongoDB, HTTP auth and read-only mocked Stripe",
  { skip: !uri, timeout: 60_000 },
  async (t) => {
    assert.match(uri!, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//);
    await mongoose.connect(uri!, {
      dbName: `usvc_dashboard_test_${randomUUID().replaceAll("-", "")}`,
      serverSelectionTimeoutMS: 5_000,
    });
    env.PAYMENT_ENVIRONMENT = "test";
    const stripe = new Stripe("sk_test_local_only");
    const intents: any[] = [];
    const charges: any[] = [];
    const refunds: any[] = [];
    let unavailable = false;
    let mutationCalls = 0;
    const readCalls: { method: string; args: any }[] = [];
    const page = (items: any[], args: any) => {
      const start = args?.starting_after
        ? items.findIndex((i) => i.id === args.starting_after) + 1
        : 0;
      assert.ok(!args?.starting_after || start > 0, "unknown provider cursor");
      const eligible = items
        .slice(start)
        .filter(
          (i) =>
            (!args?.created?.gte || i.created >= args.created.gte) &&
            (!args?.created?.lt || i.created < args.created.lt) &&
            (!args?.payment_intent || i.payment_intent === args.payment_intent) &&
            (!args?.charge || i.charge === args.charge),
        );
      return {
        data: structuredClone(eligible.slice(0, args.limit ?? 25)),
        has_more: eligible.length > (args.limit ?? 25),
      };
    };
    const mocks: any[] = [];
    for (const [name, resource, items] of [
      ["intents", stripe.paymentIntents, intents],
      ["charges", stripe.charges, charges],
      ["refunds", stripe.refunds, refunds],
    ] as const) {
      const proto = Object.getPrototypeOf(resource);
      mocks.push(
        t.mock.method(proto, "list", async (args: any) => {
          readCalls.push({ method: `${name}.list`, args });
          if (unavailable)
            throw Object.assign(new Error("SECRET customer@example.com provider payload"), {
              type: "StripeConnectionError",
            });
          return page(items, args);
        }),
      );
      if (name !== "refunds")
        mocks.push(
          t.mock.method(proto, "retrieve", async (id: string) => {
            readCalls.push({ method: `${name}.retrieve`, args: id });
            if (unavailable) throw new Error("SECRET provider payload");
            const item = items.find((i) => i.id === id);
            if (!item) throw Object.assign(new Error("Missing"), { code: "resource_missing" });
            return structuredClone(item);
          }),
        );
      for (const method of ["create", "update", "confirm", "cancel", "capture"]) {
        if (typeof proto[method] === "function")
          mocks.push(
            t.mock.method(proto, method, async () => {
              mutationCalls++;
              throw new Error("Dashboard attempted a Stripe mutation");
            }),
          );
      }
    }
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const members: Record<string, any> = {};
    const tokens: Record<string, string> = {};
    const request = async (path: string, role = "CS", body?: unknown) => {
      const response = await fetch(`${origin}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...(tokens[role] ? { authorization: `Bearer ${tokens[role]}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as any };
    };
    let seq = 0;
    const makeOrder = async (extra: any = {}) => {
      const number = `USAL-BT-20261020-${String(++seq).padStart(6, "0")}`;
      const order = await Order.create({
        publicNumber: number,
        stateSlug: "alabama",
        stateName: "Alabama",
        stateCode: "AL",
        certificate: "BIRTH",
        geo: { county: "Jefferson", city: "Birmingham" },
        reason: "Travel",
        applicant: {
          relationship: "Self",
          firstName: "Alex",
          lastName: "Example",
          phone: "+12025550111",
          email: `alex${seq}@example.com`,
        },
        subject: { firstName: "PRIVATE_SUBJECT" },
        addresses: {},
        copies: 1,
        rush: false,
        amountCents: 14900,
        currency: "usd",
        pricing: { serviceCents: 14900, rushCents: 0, totalCents: 14900 },
        consents: {
          accurate: true,
          govtId: true,
          terms: true,
          privacy: true,
          refund: true,
          processingPayment: true,
        },
        signature: "PRIVATE_SIGNATURE",
        confidentialData: {
          ssnEnc: "PRIVATE_SSN",
          cardNumberEnc: "PRIVATE_PAN",
          cardCvcEnc: "PRIVATE_CVC",
        },
        status: "AWAITING_PAYMENT",
        paymentStatus: "PENDING",
        ...extra,
      });
      return order.toObject();
    };
    const pi = (extra: any = {}) => ({
      id: `pi_${randomUUID()}`,
      created: 1_792_454_400,
      amount: 14900,
      amount_received: 14900,
      currency: "usd",
      status: "succeeded",
      livemode: false,
      metadata: {},
      receipt_email: "stripe-customer@example.com",
      latest_charge: null,
      client_secret: "PRIVATE_CLIENT_SECRET",
      ...extra,
    });
    const ch = (extra: any = {}) => ({
      id: `ch_${randomUUID()}`,
      created: 1_792_454_399,
      amount: 14900,
      amount_refunded: 0,
      currency: "usd",
      status: "succeeded",
      livemode: false,
      payment_intent: null,
      metadata: {},
      billing_details: {
        name: "Stripe Customer",
        email: "stripe-customer@example.com",
        address: { line1: "PRIVATE_BILLING_ADDRESS" },
      },
      payment_method_details: {
        card: { brand: "visa", last4: "4242", fingerprint: "PRIVATE_FINGERPRINT" },
      },
      ...extra,
    });
    try {
      await Promise.all([Order, StaffUser, StaffAccessAudit].map((m) => m.init()));
      for (const [key, role, status] of [
        ["ADMIN", "ADMIN", "active"],
        ["CS", "CS", "active"],
        ["FULFILLMENT", "FULFILLMENT", "active"],
        ["DISABLED", "CS", "disabled"],
        ["REVOKED", "CS", "active"],
      ]) {
        const member = await StaffUser.create({
          email: `${key.toLowerCase()}@example.test`,
          fullName: key,
          passwordHash: "test-only-not-used",
          role,
          accountStatus: status,
          ...(key === "REVOKED" ? { sessionsRevokedAt: new Date(Date.now() + 1000) } : {}),
        });
        members[key] = member;
        tokens[key] = jwt.sign(
          { sub: String(member._id), email: member.email, role },
          env.JWT_ACCESS_SECRET,
          { expiresIn: "30m" },
        );
      }
      const pending = await makeOrder();
      const failed = await makeOrder({ paymentStatus: "FAILED" });
      const refunded = await makeOrder({ paymentStatus: "REFUNDED", status: "CANCELLED" });
      const paid = await makeOrder({ paymentStatus: "PAID", status: "IN_REVIEW" });

      await t.test(
        "both dashboards enforce role, active-account and session revocation checks",
        async () => {
          for (const role of ["ADMIN", "CS"]) {
            assert.equal((await request("/staff/unpaid-orders/search", role, {})).status, 200);
            assert.equal((await request("/staff/payments/search", role, {})).status, 200);
          }
          const endpoints: [string, unknown?][] = [
            ["/staff/unpaid-orders/search", {}],
            [`/staff/unpaid-orders/${pending._id}`],
            [`/staff/unpaid-orders/${pending._id}/follow-ups`, { note: "Denied" }],
            ["/staff/payments/search", {}],
            ["/staff/payments/pi_missing"],
          ];
          for (const [role, status] of [
            ["SIGNED_OUT", 401],
            ["FULFILLMENT", 403],
            ["DISABLED", 403],
            ["REVOKED", 401],
          ] as const)
            for (const [path, body] of endpoints)
              assert.equal((await request(path, role, body)).status, status, `${role} ${path}`);
        },
      );

      await t.test(
        "unpaid means every payment status except PAID, with safe contact projection",
        async () => {
          const result = await request("/staff/unpaid-orders/search", "CS", {});
          assert.equal(result.body.total, 3);
          assert.deepEqual(
            new Set(result.body.orders.map((o: any) => o.paymentStatus)),
            new Set(["PENDING", "FAILED", "REFUNDED"]),
          );
          assert.ok(!result.body.orders.some((o: any) => o.id === String(paid._id)));
          const row = result.body.orders.find((o: any) => o.id === String(pending._id));
          assert.equal(row.phone, pending.applicant.phone);
          assert.equal(row.email, pending.applicant.email);
          assert.equal(row.outcome, "NOT_CONTACTED");
          assert.ok(!JSON.stringify(result.body).includes("PRIVATE_"));
          assert.deepEqual(Object.keys(result.body.counts).sort(), [
            "FAILED",
            "PENDING",
            "REFUNDED",
          ]);
        },
      );

      await t.test(
        "contact filters escape regex and customer search values do not enter audits",
        async () => {
          for (const search of [
            pending.publicNumber,
            pending.applicant.email,
            pending.applicant.phone,
            "Alex",
            "Alex Example",
            "(202) 555-0111",
          ]) {
            const result = await request("/staff/unpaid-orders/search", "CS", { search });
            assert.ok(result.body.orders.some((o: any) => o.id === String(pending._id)));
          }
          assert.equal(
            (await request("/staff/unpaid-orders/search", "CS", { search: ".*" })).body.total,
            0,
          );
          assert.equal(
            (await request("/staff/unpaid-orders/search", "CS", { paymentStatus: "REFUNDED" })).body
              .total,
            1,
          );
          assert.equal(
            (await request("/staff/unpaid-orders/search", "CS", { outcome: "NOT_CONTACTED" })).body
              .total,
            3,
          );
          const audits = await StaffAccessAudit.find().lean();
          const serialized = JSON.stringify(audits);
          assert.ok(!serialized.includes(pending.applicant.email));
          assert.ok(!serialized.includes(pending.applicant.phone));
          assert.ok(!serialized.includes("lookup"));
          assert.ok(!serialized.includes("PRIVATE_"));
        },
      );

      await t.test(
        "append-only concurrent follow-ups retain authors without claiming fulfillment",
        async () => {
          const results = await Promise.all([
            request(`/staff/unpaid-orders/${pending._id}/follow-ups`, "CS", {
              note: "Called; customer requested a callback.",
              outcome: "FOLLOW_UP_LATER",
            }),
            request(`/staff/unpaid-orders/${pending._id}/follow-ups`, "ADMIN", {
              note: "Verified contact details.",
            }),
          ]);
          assert.ok(
            results.every((r) => r.status === 201),
            JSON.stringify(results),
          );
          const stored = await Order.findById(pending._id).lean();
          assert.equal(stored.outreach.entries.length, 2);
          assert.equal(stored.notes.length, 0);
          assert.equal(stored.assignedTo, null);
          assert.equal(stored.outreach.outcome, "FOLLOW_UP_LATER");
          assert.equal(
            stored.auditEvents.filter((e: any) => e.action === "outreach_updated").length,
            2,
          );
          const detail = await request(`/staff/unpaid-orders/${pending._id}`);
          assert.equal(detail.body.history.length, 2);
          assert.deepEqual(
            new Set(detail.body.history.map((e: any) => e.author)),
            new Set(["CS", "ADMIN"]),
          );
          assert.ok(!JSON.stringify(detail.body).includes("PRIVATE_"));
        },
      );

      await t.test(
        "paid orders reject follow-ups and retain read-only outreach history",
        async () => {
          await Order.updateOne(
            { _id: pending._id },
            { $set: { paymentStatus: "PAID", status: "PAID" } },
          );
          assert.equal(
            (
              await request(`/staff/unpaid-orders/${pending._id}/follow-ups`, "CS", {
                note: "Must not be saved",
              })
            ).status,
            409,
          );
          const detail = await request(`/staff/unpaid-orders/${pending._id}`);
          assert.equal(detail.body.order.paymentStatus, "PAID");
          assert.equal(detail.body.history.length, 2);
          assert.equal(
            (await request("/staff/unpaid-orders/search", "CS", { search: pending.publicNumber }))
              .body.total,
            0,
          );
        },
      );

      await t.test(
        "unpaid pagination and date/outcome filters include legacy records",
        async () => {
          for (let i = 0; i < 28; i++)
            await makeOrder({
              createdAt: new Date(`2026-09-${String(i + 1).padStart(2, "0")}T12:00:00Z`),
            });
          const first = await request("/staff/unpaid-orders/search", "CS", {
            from: "2026-09-01",
            to: "2026-09-28",
          });
          const second = await request("/staff/unpaid-orders/search", "CS", {
            from: "2026-09-01",
            to: "2026-09-28",
            page: 2,
          });
          assert.equal(first.body.total, 28);
          assert.equal(first.body.orders.length, 25);
          assert.equal(second.body.orders.length, 3);
          assert.equal(
            new Set([...first.body.orders, ...second.body.orders].map((o: any) => o.id)).size,
            28,
          );
          assert.equal(
            (await request("/staff/unpaid-orders/search", "CS", { from: "2026-02-30" })).status,
            400,
          );
          assert.equal(
            (
              await request(`/staff/unpaid-orders/${failed._id}/follow-ups`, "CS", {
                note: "",
                outcome: "BAD",
              })
            ).status,
            400,
          );
          assert.equal(
            (
              await request(`/staff/unpaid-orders/${failed._id}/follow-ups`, "CS", {
                note: "x".repeat(2001),
              })
            ).status,
            400,
          );
          assert.equal(
            (await request("/staff/unpaid-orders/search", "CS", { paymentStatus: "PAID" })).status,
            400,
          );
        },
      );

      await t.test("read access fails closed when the audit write fails", async () => {
        const failing = t.mock.method(StaffAccessAudit, "create", () => {
          throw new Error("Audit unavailable");
        });
        try {
          const result = await request(`/staff/unpaid-orders/${refunded._id}`);
          assert.equal(result.status, 500);
          assert.equal(result.body.order, undefined);
        } finally {
          failing.mock.restore();
        }
      });

      await t.test(
        "Stripe history merges intents and standalone charges without duplicates or lost look-ahead",
        async () => {
          for (let i = 0; i < 40; i++) {
            const charge = ch({
              id: `ch_linked_${i}`,
              created: 2000 - i * 2,
              payment_intent: `pi_page_${i}`,
            });
            charges.push(charge);
            intents.push(pi({ id: `pi_page_${i}`, created: 2001 - i * 2, latest_charge: charge }));
          }
          intents[0].metadata = { orderId: String(failed._id) };
          charges.push(ch({ id: "ch_standalone_old", created: 1800 }));
          charges.push(ch({ id: "ch_standalone_new", created: 2005 }));
          charges.sort((a, b) => b.created - a.created);
          const seen: any[] = [];
          let cursor: string | undefined;
          do {
            const result = await request("/staff/payments/search", "CS", {
              ...(cursor ? { cursor } : {}),
            });
            assert.equal(result.status, 200, JSON.stringify(result.body));
            seen.push(...result.body.payments);
            cursor = result.body.nextCursor ?? undefined;
          } while (cursor);
          assert.equal(seen.length, 42);
          assert.equal(new Set(seen.map((p) => p.id)).size, 42);
          assert.equal(seen[0].id, "ch_standalone_new");
          assert.equal(
            seen[0].order,
            null,
            "a missing provider reference cannot match an unrelated order",
          );
          assert.equal(seen.at(-1).id, "ch_standalone_old");
          assert.ok(
            seen.every(
              (p, i) => !i || Date.parse(seen[i - 1].createdAt) >= Date.parse(p.createdAt),
            ),
          );
          assert.ok(seen.every((p) => p.mode === "test"));
          assert.ok(!JSON.stringify(seen).includes("PRIVATE_"));
        },
      );

      await t.test(
        "order lookup finds previous attempts by metadata and respects scanning budgets",
        async () => {
          intents.length = 0;
          charges.length = 0;
          const current = pi({
            id: "pi_current",
            created: 500,
            metadata: { orderId: String(failed._id), orderNumber: failed.publicNumber },
          });
          const earlier = pi({
            id: "pi_earlier",
            created: 100,
            metadata: { orderId: String(failed._id) },
            status: "canceled",
            amount_received: 0,
          });
          await Order.updateOne(
            { _id: failed._id },
            { $set: { stripePaymentIntentId: current.id } },
          );
          for (let i = 0; i < 180; i++) intents.push(pi({ created: 1000 - i }));
          intents.push(current, earlier);
          const seen: any[] = [];
          let cursor: string | undefined;
          do {
            const before = readCalls.length;
            const result = await request("/staff/payments/search", "CS", {
              lookup: failed.publicNumber,
              ...(cursor ? { cursor } : {}),
            });
            assert.equal(result.status, 200, JSON.stringify(result.body));
            assert.ok(readCalls.length - before <= 6);
            seen.push(...result.body.payments);
            cursor = result.body.nextCursor ?? undefined;
          } while (cursor);
          assert.deepEqual(new Set(seen.map((p) => p.id)), new Set([current.id, earlier.id]));
          assert.ok(seen.every((p) => p.order.publicNumber === failed.publicNumber));
          assert.ok(seen.find((p) => p.id === current.id).discrepancy);
          const orphan = pi({
            id: "pi_orphan",
            created: 1100,
            metadata: { orderNumber: "USAL-BT-20261020-ORPHAN" },
          });
          intents.unshift(orphan);
          const result = await request("/staff/payments/search", "CS", {
            lookup: "USAL-BT-20261020-ORPHAN",
          });
          assert.equal(result.body.payments[0].id, orphan.id);
          assert.equal(result.body.payments[0].order, null);
        },
      );

      await t.test(
        "exact payment and charge lookups show live details, attempts, refunds and discrepancies",
        async () => {
          intents.length = 0;
          charges.length = 0;
          const charge = ch({
            id: "ch_detail",
            amount_refunded: 14900,
            payment_intent: "pi_detail",
          });
          const intent = pi({
            id: "pi_detail",
            metadata: { orderId: String(failed._id) },
            latest_charge: charge,
          });
          intents.push(intent);
          charges.push(charge);
          for (let i = 0; i < 30; i++) {
            charges.push(
              ch({
                id: `ch_attempt_${i}`,
                created: 1000 - i,
                payment_intent: intent.id,
                status: "failed",
                failure_code: "card_declined",
              }),
            );
            refunds.push({
              id: `re_${i}`,
              created: 1000 - i,
              payment_intent: intent.id,
              charge: charge.id,
              amount: 100,
              currency: "usd",
              status: "succeeded",
              metadata: { private: "PRIVATE_REFUND_METADATA" },
            });
          }
          const detail = await request("/staff/payments/pi_detail");
          assert.equal(detail.status, 200, JSON.stringify(detail.body));
          assert.equal(detail.body.payment.status, "refunded");
          assert.ok(detail.body.payment.discrepancy);
          assert.equal(detail.body.payment.card.last4, "4242");
          assert.equal(detail.body.attempts.items.length, 25);
          assert.equal(detail.body.refunds.items.length, 25);
          const older = await request(
            `/staff/payments/pi_detail?attemptAfter=${detail.body.attempts.nextCursor}&refundAfter=${detail.body.refunds.nextCursor}`,
          );
          assert.equal(older.body.attempts.items.length, 6);
          assert.equal(older.body.refunds.items.length, 5);
          assert.equal(
            (await request("/staff/payments/search", "CS", { lookup: "pi_detail" })).body
              .payments[0].id,
            "pi_detail",
          );
          assert.equal(
            (await request("/staff/payments/search", "CS", { lookup: "ch_detail" })).body
              .payments[0].id,
            "ch_detail",
          );
          assert.equal(
            (await request("/staff/payments/ch_attempt_0")).body.payment.status,
            "failed",
          );
          assert.ok(!JSON.stringify(detail.body).includes("PRIVATE_"));
          assert.equal(
            (await Order.findById(failed._id).lean()).paymentStatus,
            "FAILED",
            "reads must not settle payments",
          );
        },
      );

      await t.test(
        "Stripe pending versus Flow paid is flagged without changing the order",
        async () => {
          const intent = pi({
            id: "pi_pending_vs_paid",
            status: "processing",
            amount_received: 0,
            metadata: { orderId: String(paid._id) },
          });
          intents.unshift(intent);
          const result = await request("/staff/payments/pi_pending_vs_paid");
          assert.equal(result.status, 200);
          assert.equal(result.body.payment.status, "processing");
          assert.ok(result.body.payment.discrepancy);
          assert.equal((await Order.findById(paid._id).lean()).paymentStatus, "PAID");
        },
      );

      await t.test("Stripe date filtering, cursor validation and errors are safe", async () => {
        intents.length = 0;
        charges.length = 0;
        intents.push(
          pi({ id: "pi_after_date", created: Date.parse("2026-10-21T00:00:00Z") / 1000 }),
          pi({ id: "pi_end_date", created: Date.parse("2026-10-20T23:59:59Z") / 1000 }),
          pi({ id: "pi_start_date", created: Date.parse("2026-10-20T00:00:00Z") / 1000 }),
          pi({ id: "pi_before_date", created: Date.parse("2026-10-19T23:59:59Z") / 1000 }),
        );
        const result = await stripePaymentSearch(
          stripe,
          stripeSearchSchema.parse({ from: "2026-10-20", to: "2026-10-20" }),
        );
        assert.deepEqual(
          result.payments.map((p) => p.id),
          ["pi_end_date", "pi_start_date"],
        );
        assert.equal(
          (await request("/staff/payments/search", "CS", { cursor: "not-json" })).status,
          400,
        );
        assert.equal(
          (await request("/staff/payments/search", "CS", { lookup: "someone@example.com" })).status,
          400,
        );
        assert.equal((await request("/staff/payments/pi_not_found")).status, 404);
        unavailable = true;
        try {
          for (const [path, body] of [
            ["/staff/payments/search", {}],
            ["/staff/payments/pi_detail", undefined],
          ] as const) {
            const failedResponse = await request(path, "CS", body);
            assert.equal(failedResponse.status, 503);
            assert.match(failedResponse.body.message, /not been confirmed/);
            assert.ok(!JSON.stringify(failedResponse.body).includes("SECRET"));
            assert.equal(failedResponse.body.payments, undefined);
          }
        } finally {
          unavailable = false;
        }
      });
      assert.equal(mutationCalls, 0, "dashboard code must call only Stripe read APIs");
    } finally {
      for (const mock of mocks) mock.mock.restore();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  },
);
