# usvc-backend architecture

## Wiring (`src/`)

- `server.ts`: `connectDb()` → staff-role migration (`STAFF`→`FULFILLMENT`, revoke sessions) → `app.listen` (`:4000`) → start email/GA4/OpenAI outbox workers. (No separate index bootstrap — indexes come from Mongoose schemas.)
- `app.ts`: `helmet()`, `cors({origin: FRONTEND_URL, credentials: true})` (exact, never `*`), `trust proxy 1`, `x-request-id`, `GET /health`, `/webhooks` with `express.raw({type:application/json})` **before** `express.json({limit:100kb})`. Mounts: `/auth`, `/admin`, `/staff`, `/contact-messages`, `/orders`. JSON error handler.
- `types/express.d.ts`: `req.id`. `data/geo/` (59 state/territory JSONs) copied to `dist/data/geo` on build.

## Models (`src/models/`, Mongoose only)

- `order.ts` (`orders`): applicant, per-cert subject/family (Maps), 3 addresses, geo, copies 1–9 for new/changed quantities (historical stored quantities preserved), 6 required consents + signature, pricing snapshot + `amountCents`, `assignedTo: ObjectId|null`, `analytics {clientId, sessionId, openAiEventId, oppref, obref}`, `status {DRAFT,AWAITING_PAYMENT,PAID,IN_REVIEW,TO_CS,GTG,SUBMITTED,CANCELLED}` + `paymentStatus` + `substatus` (26-value `TO_CS` list), `document` (GridFS `order_docs` bucket fileId), `customerTimeline`, `stripe*Ids`, `notes[]`, `auditEvents[]`. Dead states: `DRAFT`/`CANCELLED` exist in the enum but no transition produces them; `REFUNDED`/`FAILED` payment states surface only in tracking. Legacy rows may still carry removed `consents.independent` / `consents.openAiEmailMatching` keys (no migration).
- `staff.ts`: `staff_users {email unique, passwordHash Argon2, role ADMIN|FULFILLMENT|CS, accountStatus pending|active|disabled|blocked, inviteTokenHash sha256 48h, mfaSecret (encrypted), mfaEnabled, refreshTokenHash, sessionsRevokedAt, failedLoginAttempts/lockedUntil}` + `stripe_events {_id=eventId}` + `government_fees` + `attendance_records` (fee/attendance schemas ship, but no endpoints serve them yet — see `status.md`).
- `counter.ts` (`counters.orderSeq`), `email-outbox.ts` (`email_outbox` leased jobs), `email-dispatch.ts` (`email_dispatches` permanent transport evidence), `analytics-purchase-delivery.ts`, `openai-conversion-delivery.ts`, `contact-message.ts`.

## Lib (`src/lib/` + co-located `*.test.ts`)

Pricing/validation: `orders.ts` (`priceOrder = 14900 + (copies-1)*7000 + (rush?1200:0)`, `encodeSequence`, plate numbers), `order-validation.ts` (per-cert maps, county→city, 9 CA counties blocked, identity plausibility + format + Luhn checks, E.164 `+` phone, copies 1–9 for new/changed quantities (historical stored quantities preserved), total mismatch → 422), `order-substatus.ts`, `order-document.ts` (GridFS PDF, 10MB, `%PDF-` magic bytes), `customer-tracking.ts` (customer-safe timeline).

Crypto/auth/queue: `crypto.ts` (field helpers), `staff-auth.ts`, `staff-roles.ts` (`canSeePricing/canCorrectOrders` = ADMIN+CS), `staff-role-migration.ts`, `staff-queue.ts` (FIFO `createdAt`, `attentionFirst`, masked rows), `admin-staff-analytics.ts` (actor-event KPIs, date/workflow filters).

Email/analytics: `email-outbox.ts` (leased jobs, fenced Zoho dispatch, evidence-based reconciliation and transactional acceptance audits), `staff-email.ts`, `payment-confirmation-email.ts` (rush-branch copy, text-only, no `<img>`), `submission-notification-email.ts`, `contact-email.ts` + `contact-validation.ts`, `analytics-purchase.ts` + `analytics-outbox.ts`, `openai-conversion.ts` + `openai-conversion-outbox.ts` (always includes SHA-256 email hash for paid orders, no opt-in).

## Payment safety

`payment-attempts.ts` reserves direct/Checkout attempts atomically before application changes or Stripe calls. Direct payments create an unconfirmed intent using an attempt-scoped key, persist the reference, then confirm it. No timed lock release: after 60 seconds an interrupted attempt may be reconciled/cancelled, and only verified cancellation permits a fresh charge. Missing references are replayed only within 23 hours (inside Stripe's idempotency retention); older unknowns and unresolved legacy direct attempts fail closed. A 423 response without `orderId` keeps the current frontend on its form. Checkout shares the same fence, reuses open sessions, and cannot race a direct charge.

`payment-state.ts` validates order/attempt/Stripe ownership, server amount, currency, and test/live environment. Atomic updates preserve staff workflow, initial milestone dates, and PAID/REFUNDED against stale failures. `payment-events.ts` resolves current Stripe state before the Mongo transaction. `payment-deliveries.ts` enqueues email/GA4/OpenAI/Chat in the same transaction as settlement; unique per-order keys dedupe every paid path. Webhook event IDs are committed in that transaction; database errors are retried, not misreported as duplicates. Internal `paymentAttempt` is absent from public projections. Drain old API processes before routing payment traffic to the new code; no paid-order migration is required.

## Middleware + config

- `middleware/auth.ts`: `requireAuth` (Bearer JWT) → `requireActiveStaff` (refuses disabled/blocked + pre-revocation tokens, touches `lastActivityAt`) → `requireAdmin` (`role==ADMIN`). 5-fail/15m lockout, 10m MFA token, 30m access + 7d rotating refresh. Coverage note: `requireActiveStaff` gates `/staff/*` and `/admin/*`, but the `orders.ts` staff endpoints (detail/audit/status/document) check `requireAuth` alone — see `status.md` backlog.
- `config/env.ts`: Zod-parsed, fail-closed (prefix checks `mongodb`, `sk_`, `whsec_`, `pk_`, `G-`; requires Zoho send/Agent/OAuth credentials plus valid sender/Reply-To when `EMAIL_ENABLED=true`, GA4 when `ANALYTICS_ENABLED=true`, OpenAI when enabled).

## API contracts

Public (no token; base `http://localhost:4000`; all amounts server-computed): `GET /health`; `POST /contact-messages` (`{fullName, email, orderNumber?, message, antiAbuse}`, 5/IP/15min, honeypot → 422); `POST /orders` (full application, copies 1–9 for new/changed quantities (historical stored quantities preserved), 6 consents + signature + payment authorization, `totalCents` recomputed → 422 on mismatch; returns `{id, publicNumber, amountCents, openAiEventId}`); `POST /orders/verify-before-payment` (dry-run, no write); `GET /orders/geo/:stateCode`; `GET /orders/checkout-config` (publishable key); `GET /orders/:id/summary` (whitelisted); `POST /orders/:id/checkout-session` (`ui_mode: elements`, one integer-cent processing-total line item plus optional rush); `POST /orders/checkout-session/confirm` (re-reads Stripe, marks paid); `POST /orders/tracking` (`{publicNumber, email}`, 10/IP/15min, customer-safe timeline only); `POST /webhooks/stripe` (signature, idempotent by event ID, queues confirmation email + GA4 purchase + OpenAI `order_created`).

Staff (`requireAuth` + assigned-or-admin or `requireAdmin`): TOTP auth (`/auth/login|mfa/*|setup|refresh|logout`, invite `ADMIN`-only, 48h setup tokens); queue `GET /staff/orders` (paid, masked, `limit=25`, FIFO + attention-first); claim/release atomic (409 if taken); reassign/revoke/MFA-reset ADMIN-only; detail/notes/correction/status/documents owner-or-ADMIN (CS must own to correct or mark `GTG`; pricing visible to ADMIN/CS only); admin roster/analytics/workload/activity; self `GET /staff/analytics`. Keep public projections whitelisted; staff reads only through authorized, audited endpoints.

## ADMIN/CS contact and payment dashboards

`unpaid-orders.ts` and `staff-payments.ts` mount before the general `/staff` router and enforce `requireAuth → requireActiveStaff → requireAdminOrCs`. The unpaid queue includes `paymentStatus != PAID`, with explicit contact-only projections and atomic append-only outreach writes. `Order.outreach` holds the separate five-state outcome and dated notes, independent of fulfillment assignments; paid conversion makes it read-only. Existing fulfillment detail excludes this field. `staff_access_audit` records authorized reads without storing search text, contacts or provider payloads.

`stripe-history.ts` exposes a read-only Stripe client interface, merges PaymentIntents/standalone Charges with per-source cursors, and caps each search at six list calls. Order-number lookup continues across historical metadata (including missing local orders); deep scans may return an empty batch with a valid continuation. Exact IDs retrieve current details; charge/refund histories paginate independently. Whitelisted responses include amounts, safe failure copy, brand/last4, optional Flow matches and discrepancies. No Stripe mutation, background sync, payment-status write or account-wide customer search is performed. List/detail reads are audited and errors are sanitized. UI callers use POST bodies for search and the same-origin proxy.

## Deploy shape

`render.yaml`: service `usvc-api`, `rootDir: usvc-backend`, `npm ci && npm run build` / `npm run start`, `/health` check, Node 24. YAML holds non-secret defaults; secrets (`sync: false`) set in dashboard: `MONGODB_URI`, `MONGODB_DB_NAME`, `FRONTEND_URL` (exact prod origin), JWT secrets, Stripe keys, `STAFF_PORTAL_URL`, `SENSITIVE_ENCRYPTION_KEY` (fresh per env — losing prod key is unrecoverable). Local: `cp .env.example .env`, `npm install`, `npm run dev`. Before real orders: paid Atlas + backups, least-privilege user + IP allow, prod webhook + secret, key isolation, staging `EMAIL_RECIPIENT_OVERRIDE`. Outbox failures inspected in Mongo.

## Shared facts (both repos)

Order milestones: Payment Successful → Order Received → Order Processing → Order Processed (Submitted to Govt Agency); exception `TO_CS` shows neutral message only. Staff flow: `PAID → IN_REVIEW → SUBMITTED` + `IN_REVIEW → TO_CS` (note required, 26-value substatus, auto-releases) → `TO_CS → GTG` → `GTG → IN_REVIEW`. Roles: ADMIN (all), FULFILLMENT (own orders), CS (own + correction + `GTG` + pricing). Invite-only, no self-register; 8+ char passwords; 30m access + 7d rotating refresh; 5 fails/15min lockout. Order numbers `US<ST>-<BT|DT|MG|DV>-<YYYYMMDD>-<DDLDDD>`, opaque everywhere. Pricing cents: copies × $149 + $12 rush; agency/shipping charged later, never in total.

## Secure application recovery

`/recovery` handles email-only requests, explicit code delivery/verification, and cookie-authenticated application listing/detail/edit/pay/status. CS/ADMIN issue or replace order-scoped grants through `/staff/unpaid-orders/:id/resume-link`. Recovery state and shared throttles use separate Mongo collections with explicit expiry checks and TTL cleanup. Token fragments are exchanged in request bodies; only HMAC hashes are retained in grants/challenges/sessions. Delivery secrets are encrypted temporarily in the existing email outbox. Recovery mutations check the frontend Origin; the same-origin proxy forwards only the recovery cookie and preserves Set-Cookie. Sessions expire after 30 minutes and are checked against grant revocation every request.

Recovery uses `applicationRevision` and the shared payment reservation filter to reject stale writes, paid/refunded orders, and unresolved attempts. `direct-payment.ts` is the shared charge/settlement orchestration for normal and recovery submissions. The validation-only `storedSsn` option is supplied only after verified recovery finds an existing encrypted SSN. No recovery read decrypts or exposes it; fresh cards are never persisted by recovery. Existing pricing/validation and transaction-safe settlement outboxes remain authoritative.

## Customer email presentation and resume URLs

`customer-email-layout.ts` supplies email-safe presentation tables, typography, CTA markup and the support/website/dynamic-year footer for customer messages. Internal notifications remain separate. `recovery-email.ts` renders link/code messages without changing their plain-text contract. `recovery-url.ts` builds descriptive order-specific fragment links; URL context never authorizes access. SELF requests with an order number create order-scoped grants; email-only requests remain email-scoped.

## Zoho CPaaS transport

`zoho-email.ts` sends JSON over HTTPS to the India API and refreshes read-only log OAuth tokens through the India account service. Sending keys and OAuth credentials stay server-only; tracking is disabled explicitly. Templates and all public/recovery APIs are unchanged.

The outbox reserves an `email_dispatches` record transactionally before sending, using an opaque stable reference. Receipts contain only record IDs, timestamps, sanitized states/codes and provider IDs. A definite retryable rejection can requeue; a timeout/crash/ambiguous response cannot. Unknown attempts reconcile via reference-filtered logs, with a 24-hour/earlier-expiry cutoff and manual review. Provider acceptance, not inbox delivery, maps to existing SENT/audit semantics. Receipts survive recovery TTL deletion; acceptance finalization and audit events share a transaction. Previously attempted legacy jobs are held instead of being replayed through Zoho. The new release has no Resend client, package or fallback.

See [Zoho environment setup and cutover](zoho-email-migration.md) for both repositories, OAuth scope, staging recipient overrides, old-key removal, operations-only reporting/reconciliation, queue review and rollback. No infrastructure service type, mailbox provider, payment flow or frontend variable changes are required.
