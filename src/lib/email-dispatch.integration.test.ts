import { applyZohoWebhook } from "./zoho-webhook.js";
import { app } from "../app.js";
import { createHmac } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { EmailOutbox } from "../models/email-outbox.js";
import { EmailDispatch } from "../models/email-dispatch.js";
import { ContactMessage } from "../models/contact-message.js";
import { StaffUser } from "../models/staff.js";
import { Order } from "../models/order.js";
import { RecoveryGrant, RecoveryChallenge } from "../models/recovery.js";
import { env } from "../config/env.js";
import { zohoEmail, ZohoEmailClient, type SendResult } from "./zoho-email.js";
import { processNextEmail, reconcileEmailDispatch } from "./email-outbox.js";
import { encryptSensitive } from "./crypto.js";
import { hashInviteToken } from "./staff-auth.js";
const uri = process.env.PAYMENT_TEST_MONGODB_URI;
test(
  "Zoho outbox fencing, ambiguous delivery, legacy cutover and permanent receipts",
  { skip: !uri, timeout: 60000 },
  async (t) => {
    assert.match(uri!, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//);
    await mongoose.connect(uri!, {
      dbName: "usvc_zoho_dispatch_" + randomUUID().replaceAll("-", ""),
    });
    const old = { ...env };
    Object.assign(env, {
      EMAIL_ENABLED: true,
      EMAIL_FROM: "USVC <noreply@example.test>",
      EMAIL_REPLY_TO: "support@example.test",
      EMAIL_RECIPIENT_OVERRIDE: undefined,
      FRONTEND_URL: "https://example.test",
      STAFF_PORTAL_URL: "https://example.test",
    });
    await Promise.all(
      [
        EmailOutbox,
        EmailDispatch,
        ContactMessage,
        Order,
        StaffUser,
        RecoveryGrant,
        RecoveryChallenge,
      ].map((m) => m.init()),
    );
    let sends = 0,
      lookups = 0,
      result: SendResult = { kind: "accepted", messageId: "zoho-sent" },
      found: { messageId: string } | null = null;
    const bodies: any[] = [];
    t.mock.method(zohoEmail, "send", async (body: any) => {
      sends++;
      bodies.push(body);
      return result;
    });
    t.mock.method(zohoEmail, "find", async () => {
      lookups++;
      return found;
    });
    const clean = async () => {
      await Promise.all(
        [
          EmailOutbox,
          EmailDispatch,
          ContactMessage,
          Order,
          StaffUser,
          RecoveryGrant,
          RecoveryChallenge,
        ].map((m) => m.deleteMany({})),
      );
      sends = lookups = 0;
      bodies.length = 0;
      result = { kind: "accepted", messageId: "zoho-sent" };
      found = null;
    };
    const job = async (id = randomUUID(), extra: Record<string, unknown> = {}) => {
      const contact = await ContactMessage.create({
        fullName: "Synthetic",
        email: "synthetic@example.test",
        message: "Synthetic inquiry",
      });
      return EmailOutbox.create({
        _id: id,
        recipient: "synthetic@example.test",
        template: "CONTACT_CUSTOMER_RECEIPT",
        contactMessageId: contact._id,
        ...extra,
      });
    };
    const due = async (id: string) =>
      EmailDispatch.updateOne(
        { _id: id },
        { $set: { nextReconcileAt: new Date(0), reconcileLeaseUntil: new Date(0) } },
      );
    try {
      await t.test(
        "simultaneous workers send once and finalize one transactional audit",
        async () => {
          const message = await job();
          await Promise.all([processNextEmail(), processNextEmail()]);
          assert.equal(sends, 1);
          assert.equal((await EmailOutbox.findById(message._id).lean()).status, "SENT");
          assert.equal(
            (await ContactMessage.findById(message.contactMessageId).lean()).emailEvents.length,
            1,
          );
          await EmailOutbox.deleteOne({ _id: message._id });
          await job(message._id);
          await processNextEmail();
          assert.equal(sends, 1);
          assert.equal((await EmailOutbox.findById(message._id).lean()).status, "SENT");
        },
      );
      await clean();
      await t.test(
        "confirmed rate-limit rejection permits a fresh guarded dispatch and preserves retry delay",
        async () => {
          const message = await job();
          result = {
            kind: "rejected",
            retryable: true,
            code: "ZOHO_RATE_LIMIT",
            retryAfterMs: 120000,
          };
          const start = Date.now();
          await processNextEmail();
          const rejected = await EmailOutbox.findById(message._id).lean();
          assert.equal(rejected.status, "PENDING");
          assert.ok(rejected.nextAttemptAt.getTime() >= start + 120000);
          assert.equal((await EmailDispatch.findById(message._id).lean()).state, "READY");
          await EmailOutbox.updateOne(
            { _id: message._id },
            { $set: { nextAttemptAt: new Date(0) } },
          );
          result = { kind: "accepted", messageId: "retried" };
          await processNextEmail();
          assert.equal(sends, 2);
          assert.equal((await EmailOutbox.findById(message._id).lean()).status, "SENT");
        },
      );
      await clean();
      await t.test(
        "uncertain sends never retry and delayed provider evidence completes delivery",
        async () => {
          const message = await job();
          result = { kind: "uncertain", code: "ZOHO_REQUEST_UNCERTAIN" };
          await processNextEmail();
          assert.equal((await EmailOutbox.findById(message._id).lean()).status, "HELD");
          await due(message._id);
          await processNextEmail();
          assert.equal(sends, 1);
          assert.equal(lookups, 1);
          assert.equal((await EmailDispatch.findById(message._id).lean()).state, "UNCERTAIN");
          found = { messageId: "accepted-before-timeout" };
          await due(message._id);
          await Promise.all([processNextEmail(), processNextEmail()]);
          assert.equal(sends, 1);
          assert.equal(
            (await EmailOutbox.findById(message._id).lean()).providerMessageId,
            found.messageId,
          );
          assert.equal(
            (await ContactMessage.findById(message.contactMessageId).lean()).emailEvents.length,
            1,
          );
        },
      );
      await clean();
      await t.test(
        "crash after reservation reconciles a reclaimed lease rather than dispatching again",
        async () => {
          const message = await job("crash", {
            status: "SENDING",
            attempts: 1,
            leaseExpiresAt: new Date(0),
          });
          await EmailDispatch.create({
            _id: message._id,
            reference: "opaque-crash",
            provider: "ZOHO",
            state: "DISPATCHING",
            template: message.template,
            contactMessageId: message.contactMessageId,
            startedAt: new Date(),
            deadlineAt: new Date(Date.now() + 86400000),
            nextReconcileAt: new Date(0),
          });
          found = { messageId: "crash-accepted" };
          await processNextEmail();
          assert.equal(sends, 0);
          assert.equal((await EmailOutbox.findById(message._id).lean()).status, "SENT");
        },
      );
      await clean();
      await t.test(
        "crash after provider acceptance and before finalization recovers without provider calls",
        async () => {
          const message = await job("accepted-crash", {
            status: "SENDING",
            attempts: 1,
            leaseExpiresAt: new Date(0),
          });
          await EmailDispatch.create({
            _id: message._id,
            reference: "accepted-reference",
            provider: "ZOHO",
            state: "ACCEPTED",
            providerMessageId: "accepted-id",
            acceptedAt: new Date(),
            template: message.template,
            contactMessageId: message.contactMessageId,
            nextReconcileAt: new Date(0),
          });
          await processNextEmail();
          assert.equal(sends, 0);
          assert.equal(lookups, 0);
          assert.equal((await EmailOutbox.findById(message._id).lean()).status, "SENT");
        },
      );
      await clean();
      await t.test(
        "lost acceptance DB response leaves dispatch evidence and never enters the retry path",
        async (st) => {
          const message = await job();
          const update = EmailDispatch.updateOne.bind(EmailDispatch);
          let failed = false;
          st.mock.method(EmailDispatch, "updateOne", (...args: any[]) => {
            if (args[1]?.$set?.state === "ACCEPTED" && !failed) {
              failed = true;
              throw Error("synthetic database failure");
            }
            return update(...(args as Parameters<typeof update>));
          });
          await processNextEmail();
          assert.equal(sends, 1);
          assert.equal((await EmailDispatch.findById(message._id).lean()).state, "DISPATCHING");
          await due(message._id);
          found = { messageId: "recovered" };
          await processNextEmail();
          assert.equal(sends, 1);
          assert.equal((await EmailOutbox.findById(message._id).lean()).status, "SENT");
        },
      );
      await clean();
      await t.test(
        "a slow dispatch remains exclusive after lease reclamation, including a definitive rejection",
        async (st) => {
          for (const accepted of [true, false]) {
            let entered!: () => void, release!: () => void;
            const started = new Promise<void>((resolve) => {
              entered = resolve;
            });
            const gate = new Promise<void>((resolve) => {
              release = resolve;
            });
            const mock = st.mock.method(zohoEmail, "send", async () => {
              sends++;
              entered();
              await gate;
              return accepted
                ? { kind: "accepted", messageId: "late-accept" }
                : { kind: "rejected", retryable: true, code: "ZOHO_RATE_LIMIT" };
            });
            const message = await job();
            const first = processNextEmail();
            await started;
            await EmailOutbox.updateOne(
              { _id: message._id },
              { $set: { leaseExpiresAt: new Date(0) } },
            );
            await processNextEmail();
            assert.equal(sends, 1);
            assert.equal((await EmailOutbox.findById(message._id).lean()).status, "HELD");
            release();
            await first;
            assert.equal(
              (await EmailOutbox.findById(message._id).lean()).status,
              accepted ? "SENT" : "PENDING",
            );
            mock.mock.restore();
            await clean();
          }
        },
      );
      await clean();
      await t.test("legacy attempted jobs are held; untouched jobs can move to Zoho", async () => {
        const legacy = await job("legacy", { attempts: 2 });
        await processNextEmail();
        assert.equal(sends, 0);
        assert.equal((await EmailOutbox.findById(legacy._id).lean()).status, "HELD");
        assert.equal((await EmailDispatch.findById(legacy._id).lean()).provider, "LEGACY");
        await job("untouched");
        await processNextEmail();
        assert.equal(sends, 1);
      });
      await clean();
      await t.test(
        "permanent rejection stops delivery and sanitized diagnostics exclude contents",
        async () => {
          const message = await job();
          result = { kind: "rejected", retryable: false, code: "ZOHO_TM_3004" };
          await processNextEmail();
          const stored = await EmailOutbox.findById(message._id).lean();
          assert.equal(stored.status, "FAILED");
          assert.equal(stored.lastError, "ZOHO_TM_3004");
          const proof = await EmailDispatch.findById(message._id).lean();
          assert.doesNotMatch(
            JSON.stringify(proof),
            /synthetic@example|Synthetic inquiry|htmlbody|Zoho-enczapikey/,
          );
        },
      );
      await clean();
      await t.test(
        "expiry and 24-hour cutoff retain evidence and never resend; manual reconciliation remains read-only",
        async () => {
          const message = await job();
          result = { kind: "uncertain", code: "ZOHO_REQUEST_UNCERTAIN" };
          await processNextEmail();
          await EmailDispatch.updateOne(
            { _id: message._id },
            { $set: { deadlineAt: new Date(0), nextReconcileAt: new Date(0) } },
          );
          await processNextEmail();
          assert.equal((await EmailDispatch.findById(message._id).lean()).state, "REVIEW");
          assert.equal(lookups, 0);
          assert.equal(sends, 1);
          await reconcileEmailDispatch(message._id, true);
          assert.equal((await EmailDispatch.findById(message._id).lean()).state, "REVIEW");
          assert.equal(sends, 1);
          found = { messageId: "late-evidence" };
          await reconcileEmailDispatch(message._id, true);
          assert.equal((await EmailOutbox.findById(message._id).lean()).status, "SENT");
          assert.equal(sends, 1);
        },
      );
      await clean();
      await t.test(
        "verification expiry deletes secrets but a permanent receipt can reconcile after TTL removes the job",
        async () => {
          const grant = await RecoveryGrant.create({
            email: "synthetic@example.test",
            source: "SELF",
            tokenHash: "synthetic",
            expiresAt: new Date(Date.now() + 86400000),
          });
          const challenge = await RecoveryChallenge.create({
            grantId: grant._id,
            codeHash: "synthetic",
            expiresAt: new Date(Date.now() + 600000),
          });
          const message = await EmailOutbox.create({
            _id: "code-expiry",
            recipient: "synthetic@example.test",
            template: "RECOVERY_CODE",
            recoveryGrantId: grant._id,
            recoveryChallengeId: challenge._id,
            recoveryExpiresAt: challenge.expiresAt,
            recoverySecret: encryptSensitive("123456"),
          });
          result = { kind: "uncertain", code: "ZOHO_REQUEST_UNCERTAIN" };
          await processNextEmail();
          await EmailOutbox.deleteOne({ _id: message._id });
          await due(message._id);
          found = { messageId: "code-accepted" };
          await processNextEmail();
          assert.equal(sends, 1);
          assert.equal((await EmailDispatch.findById(message._id).lean()).state, "ACCEPTED");
          assert.ok((await EmailDispatch.findById(message._id).lean()).finalizedAt);
        },
      );
      await clean();
      await t.test(
        "all non-recovery email branches preserve sender, Reply-To, templates and recipient override",
        async () => {
          Object.assign(env, { EMAIL_RECIPIENT_OVERRIDE: "staging@example.test" });
          const contact = await ContactMessage.create({
            fullName: "Synthetic",
            email: "reply@example.test",
            message: "Synthetic inquiry",
          });
          for (const template of ["CONTACT_SUPPORT_NOTIFICATION", "CONTACT_CUSTOMER_RECEIPT"])
            await EmailOutbox.create({
              _id: template,
              recipient: "intended@example.test",
              template,
              contactMessageId: contact._id,
            });
          const staff = await StaffUser.create({
            email: "staff@example.test",
            fullName: "Staff",
            role: "CS",
            accountStatus: "pending",
            passwordHash: "unused",
            inviteTokenHash: hashInviteToken("setup-token"),
          });
          await EmailOutbox.create({
            _id: "invite",
            template: "STAFF_INVITATION",
            recipient: staff.email,
            staffUserId: staff._id,
            setupToken: "setup-token",
          });
          const order = await Order.create({
            publicNumber: "TEST-ORDER",
            stateSlug: "alabama",
            stateName: "Alabama",
            stateCode: "AL",
            certificate: "BIRTH",
            geo: { county: "Jefferson", city: "Birmingham" },
            reason: "Travel",
            applicant: {
              relationship: "Self",
              firstName: "Jane",
              lastName: "Example",
              phone: "+15550100100",
              email: "intended@example.test",
            },
            copies: 1,
            signature: "Jane Example",
            consents: {
              accurate: true,
              govtId: true,
              terms: true,
              privacy: true,
              refund: true,
              processingPayment: true,
            },
            pricing: { serviceCents: 14900, rushCents: 0, totalCents: 14900 },
            amountCents: 14900,
            currency: "usd",
            status: "SUBMITTED",
            paymentStatus: "PAID",
          });
          for (const template of ["PAYMENT_CONFIRMATION", "SUBMISSION_NOTIFICATION"])
            await EmailOutbox.create({
              _id: template,
              recipient: order.applicant.email,
              orderId: order._id,
              template,
            });
          while (await processNextEmail()) {}
          assert.equal(sends, 5);
          assert.ok(
            bodies.every(
              (body) => body.to === "staging@example.test" && body.from === env.EMAIL_FROM,
            ),
          );
          assert.equal(
            bodies.find((body) => body.subject.startsWith("New contact inquiry")).replyTo,
            "reply@example.test",
          );
          assert.ok(bodies.some((body) => body.subject.includes("Order confirmed")));
          assert.ok(bodies.some((body) => body.subject.includes("Your order has been submitted")));
          Object.assign(env, { EMAIL_RECIPIENT_OVERRIDE: undefined });
        },
      );
      await clean();
      await t.test(
        "email-disabled environments make no sends or reconciliation calls",
        async () => {
          await job();
          env.EMAIL_ENABLED = false;
          assert.equal(await processNextEmail(), false);
          assert.equal(sends, 0);
          assert.equal(lookups, 0);
          env.EMAIL_ENABLED = true;
        },
      );
      await clean();
      await t.test(
        "signed API delivery callbacks resolve timeouts once and preserve terminal outcomes",
        async () => {
          env.ZOHO_EMAIL_AGENT_KEY = "synthetic-agent";
          env.ZOHO_WEBHOOK_SECRET = "s".repeat(32);
          const server = app.listen(0, "127.0.0.1");
          await new Promise<void>((resolve) => server.once("listening", resolve));
          const port = (server.address() as { port: number }).port;
          try {
            const message = await job();
            result = { kind: "uncertain", code: "ZOHO_REQUEST_UNCERTAIN" };
            await processNextEmail();
            const receipt = await EmailDispatch.findById(message._id).lean();
            const event = {
              mailagent_key: "synthetic-agent",
              webhook_request_id: "event-1",
              event_name: ["delivered"],
              event_message: [
                {
                  email_info: {
                    client_reference: receipt!.reference,
                    email_reference: "api-provider-reference",
                    is_smtp_trigger: false,
                    subject: "private discarded content",
                    to: "private@example.test",
                  },
                },
              ],
            };
            const payload = JSON.stringify(event);
            const body = new URLSearchParams({ payload }).toString();
            const post = (signature: string) =>
              fetch(`http://127.0.0.1:${port}/webhooks/zoho`, {
                method: "POST",
                headers: {
                  "content-type": "application/x-www-form-urlencoded",
                  "producer-signature": signature,
                },
                body,
              });
            assert.equal((await post("invalid")).status, 401);
            assert.equal((await EmailDispatch.findById(message._id).lean())!.state, "UNCERTAIN");
            const signature = `ts=${Date.now()};s=${encodeURIComponent(createHmac("sha256", env.ZOHO_WEBHOOK_SECRET!).update(payload).digest("base64"))};s-algorithm=HmacSHA256`;
            const responses = await Promise.all([post(signature), post(signature)]);
            assert.ok(responses.every((response) => response.status === 200));
            assert.equal((await EmailOutbox.findById(message._id).lean())!.status, "SENT");
            assert.equal(
              (await EmailDispatch.findById(message._id).lean())!.deliveryStatus,
              "DELIVERED",
            );
            await applyZohoWebhook({ ...event, event_name: ["softbounce"] });
            assert.equal(
              (await EmailDispatch.findById(message._id).lean())!.deliveryStatus,
              "DELIVERED",
            );
            await applyZohoWebhook({ ...event, event_name: ["hardbounce"] });
            await applyZohoWebhook(event);
            const final = await EmailDispatch.findById(message._id).lean();
            assert.equal(final!.deliveryStatus, "HARD_BOUNCED");
            assert.doesNotMatch(JSON.stringify(final), /private|discarded/);
            assert.equal(sends, 1);
            assert.equal(lookups, 0);
            assert.equal(await processNextEmail(), false);
            const contact = await ContactMessage.findById(message.contactMessageId).lean();
            assert.equal(
              contact!.emailEvents.filter(
                (entry: { action: string }) => entry.action === "contact_email_sent",
              ).length,
              1,
            );
          } finally {
            await new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            );
          }
        },
      );
      await clean();
      await t.test(
        "late callbacks resolve expired-job receipts without a resend or exposing secrets",
        async () => {
          const message = await job();
          result = { kind: "uncertain", code: "ZOHO_REQUEST_UNCERTAIN" };
          await processNextEmail();
          const receipt = await EmailDispatch.findById(message._id).lean();
          await EmailDispatch.updateOne({ _id: message._id }, { $set: { state: "REVIEW" } });
          await EmailOutbox.deleteOne({ _id: message._id });
          const payload = {
            mailagent_key: env.ZOHO_EMAIL_AGENT_KEY,
            webhook_request_id: "late-event",
            event_name: ["delivered"],
            event_message: [
              {
                email_info: {
                  client_reference: receipt!.reference,
                  email_reference: "late-provider-id",
                  is_smtp_trigger: true,
                },
              },
            ],
          };
          await applyZohoWebhook(payload);
          await applyZohoWebhook(payload);
          assert.equal((await EmailDispatch.findById(message._id).lean())!.state, "ACCEPTED");
          assert.equal(await EmailOutbox.countDocuments(), 0);
          assert.equal(
            (await ContactMessage.findById(message.contactMessageId).lean())!.emailEvents.length,
            1,
          );
          assert.equal(sends, 1);
        },
      );
      await clean();
      await t.test(
        "real API adapter resolves a lost send response through read-only logs without another POST",
        async (st) => {
          env.ZOHO_WEBHOOK_SECRET = undefined;
          env.ZOHO_EMAIL_API_KEY = "synthetic-send-key";
          env.ZOHO_EMAIL_AGENT_KEY = "synthetic-agent";
          const client = new ZohoEmailClient();
          st.mock.method(zohoEmail, "send", client.send.bind(client));
          st.mock.method(zohoEmail, "find", client.find.bind(client));
          let providerSends = 0,
            logReads = 0,
            reference = "";
          st.mock.method(globalThis, "fetch", async (input: unknown, options: RequestInit) => {
            const url = String(input);
            if (url.includes("accounts.zoho.in"))
              return new Response(
                JSON.stringify({ access_token: "synthetic-access", expires_in: 3600 }),
              );
            if (options.method === "POST") {
              providerSends++;
              assert.equal(
                (options.headers as Record<string, string>).Authorization,
                "Zoho-enczapikey synthetic-send-key",
              );
              const body = JSON.parse(String(options.body));
              reference = body.client_reference;
              assert.equal(body.track_clicks, false);
              assert.equal(body.track_opens, false);
              // Zoho accepted the message, but its HTTP response was lost.
              throw Error("synthetic lost response");
            }
            logReads++;
            assert.equal(new URL(url).searchParams.get("client_reference"), reference);
            return new Response(
              JSON.stringify({
                status: "success",
                data: [
                  {
                    mailagent_key: "synthetic-agent",
                    client_reference: reference,
                    request_id: "existing-provider-id",
                  },
                ],
              }),
            );
          });
          const message = await job();
          await processNextEmail();
          assert.equal((await EmailOutbox.findById(message._id).lean())!.status, "HELD");
          await EmailDispatch.updateOne(
            { _id: message._id },
            { $set: { nextReconcileAt: new Date(0) } },
          );
          await processNextEmail();
          assert.equal((await EmailOutbox.findById(message._id).lean())!.status, "SENT");
          assert.equal(
            (await ContactMessage.findById(message.contactMessageId).lean())!.emailEvents.length,
            1,
          );
          assert.equal(providerSends, 1);
          assert.equal(logReads, 1);
        },
      );
      await clean();
      await t.test(
        "wrong Agent, unknown references and unknown events cannot finalize jobs",
        async () => {
          const message = await job();
          result = { kind: "uncertain", code: "ZOHO_REQUEST_UNCERTAIN" };
          await processNextEmail();
          const receipt = await EmailDispatch.findById(message._id).lean();
          for (const [agent, reference, smtp] of [
            ["wrong", receipt!.reference, true],
            [env.ZOHO_EMAIL_AGENT_KEY, "a".repeat(64), true],
          ] as const)
            await applyZohoWebhook({
              mailagent_key: agent,
              webhook_request_id: "test",
              event_name: ["delivered"],
              event_message: [
                {
                  email_info: {
                    client_reference: reference,
                    email_reference: "ref",
                    is_smtp_trigger: smtp,
                  },
                },
              ],
            });
          assert.equal((await EmailDispatch.findById(message._id).lean())!.state, "UNCERTAIN");
          await applyZohoWebhook({
            mailagent_key: env.ZOHO_EMAIL_AGENT_KEY,
            webhook_request_id: "unknown-event",
            event_name: ["__proto__"],
            event_message: [
              {
                email_info: {
                  client_reference: receipt!.reference,
                  email_reference: "ref",
                  is_smtp_trigger: false,
                },
              },
            ],
          });
          assert.equal((await EmailDispatch.findById(message._id).lean())!.state, "UNCERTAIN");
          assert.equal(sends, 1);
        },
      );
    } finally {
      Object.assign(env, old);
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  },
);
