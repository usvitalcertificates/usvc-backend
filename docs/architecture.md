# usvc-backend architecture

## Wiring (`src/`)

- `server.ts`: `connectDb()` → staff-role migration (`STAFF`→`FULFILLMENT`, revoke sessions) → `app.listen` (`:4000`) → start email/GA4/OpenAI outbox workers. (No separate index bootstrap — indexes come from Mongoose schemas.)
- `app.ts`: `helmet()`, `cors({origin: FRONTEND_URL, credentials: true})` (exact, never `*`), `trust proxy 1`, `x-request-id`, `GET /health`, `/webhooks` with `express.raw({type:application/json})` **before** `express.json({limit:100kb})`. Mounts: `/auth`, `/admin`, `/staff`, `/contact-messages`, `/orders`. JSON error handler.
- `types/express.d.ts`: `req.id`. `data/geo/` (59 state/territory JSONs) copied to `dist/data/geo` on build.

## Models (`src/models/`, Mongoose only)

- `order.ts` (`orders`): applicant, per-cert subject/family (Maps), 3 addresses, geo, copies 1–20, 6 required consents + signature, pricing snapshot + `amountCents`, `assignedTo: ObjectId|null`, `analytics {clientId, sessionId, openAiEventId, oppref, obref}`, `status {DRAFT,AWAITING_PAYMENT,PAID,IN_REVIEW,TO_CS,GTG,SUBMITTED,CANCELLED}` + `paymentStatus` + `substatus` (26-value `TO_CS` list), `document` (GridFS `order_docs` bucket fileId), `customerTimeline`, `stripe*Ids`, `notes[]`, `auditEvents[]`. Dead states: `DRAFT`/`CANCELLED` exist in the enum but no transition produces them; `REFUNDED`/`FAILED` payment states surface only in tracking. Legacy rows may still carry removed `consents.independent` / `consents.openAiEmailMatching` keys (no migration).
- `staff.ts`: `staff_users {email unique, passwordHash Argon2, role ADMIN|FULFILLMENT|CS, accountStatus pending|active|disabled|blocked, inviteTokenHash sha256 48h, mfaSecret (encrypted), mfaEnabled, refreshTokenHash, sessionsRevokedAt, failedLoginAttempts/lockedUntil}` + `stripe_events {_id=eventId}` + `government_fees` + `attendance_records` (fee/attendance schemas ship, but no endpoints serve them yet — see `status.md`).
- `counter.ts` (`counters.orderSeq`), `email-outbox.ts` (`email_outbox` leased jobs), `analytics-purchase-delivery.ts`, `openai-conversion-delivery.ts`, `contact-message.ts`.

## Lib (`src/lib/` + co-located `*.test.ts`)

Pricing/validation: `orders.ts` (`priceOrder = copies*14900 + rush?4500:0`, `encodeSequence`, plate numbers), `order-validation.ts` (per-cert maps, county→city, 9 CA counties blocked, identity plausibility + format + Luhn checks, E.164 `+` phone, copies 1–20, total mismatch → 422), `order-substatus.ts`, `order-document.ts` (GridFS PDF, 10MB, `%PDF-` magic bytes), `customer-tracking.ts` (customer-safe timeline).

Crypto/auth/queue: `crypto.ts` (field helpers), `staff-auth.ts`, `staff-roles.ts` (`canSeePricing/canCorrectOrders` = ADMIN+CS), `staff-role-migration.ts`, `staff-queue.ts` (FIFO `createdAt`, `attentionFirst`, masked rows), `admin-staff-analytics.ts` (actor-event KPIs, date/workflow filters).

Email/analytics: `email-outbox.ts` (leased retries, idempotency keys), `staff-email.ts`, `payment-confirmation-email.ts` (rush-branch copy, text-only, no `<img>`), `submission-notification-email.ts`, `contact-email.ts` + `contact-validation.ts`, `analytics-purchase.ts` + `analytics-outbox.ts`, `openai-conversion.ts` + `openai-conversion-outbox.ts` (always includes SHA-256 email hash for paid orders, no opt-in).

## Middleware + config

- `middleware/auth.ts`: `requireAuth` (Bearer JWT) → `requireActiveStaff` (refuses disabled/blocked + pre-revocation tokens, touches `lastActivityAt`) → `requireAdmin` (`role==ADMIN`). 5-fail/15m lockout, 10m MFA token, 30m access + 7d rotating refresh. Coverage note: `requireActiveStaff` gates `/staff/*` and `/admin/*`, but the `orders.ts` staff endpoints (detail/audit/status/document) check `requireAuth` alone — see `status.md` backlog.
- `config/env.ts`: Zod-parsed, fail-closed (prefix checks `mongodb`, `sk_`, `whsec_`, `pk_`, `re_`, `G-`; requires Resend set when `EMAIL_ENABLED=true`, GA4 when `ANALYTICS_ENABLED=true`, OpenAI when enabled).

## API contracts

Public (no token; base `http://localhost:4000`; all amounts server-computed): `GET /health`; `POST /contact-messages` (`{fullName, email, orderNumber?, message, antiAbuse}`, 5/IP/15min, honeypot → 422); `POST /orders` (full application, copies 1–20, 6 consents + signature + payment authorization, `totalCents` recomputed → 422 on mismatch; returns `{id, publicNumber, amountCents, openAiEventId}`); `POST /orders/verify-before-payment` (dry-run, no write); `GET /orders/geo/:stateCode`; `GET /orders/checkout-config` (publishable key); `GET /orders/:id/summary` (whitelisted); `POST /orders/:id/checkout-session` (`ui_mode: elements`, 3 line items); `POST /orders/checkout-session/confirm` (re-reads Stripe, marks paid); `POST /orders/tracking` (`{publicNumber, email}`, 10/IP/15min, customer-safe timeline only); `POST /webhooks/stripe` (signature, idempotent by event ID, queues confirmation email + GA4 purchase + OpenAI `order_created`).

Staff (`requireAuth` + assigned-or-admin or `requireAdmin`): TOTP auth (`/auth/login|mfa/*|setup|refresh|logout`, invite `ADMIN`-only, 48h setup tokens); queue `GET /staff/orders` (paid, masked, `limit=25`, FIFO + attention-first); claim/release atomic (409 if taken); reassign/revoke/MFA-reset ADMIN-only; detail/notes/correction/status/documents owner-or-ADMIN (CS must own to correct or mark `GTG`; pricing visible to ADMIN/CS only); admin roster/analytics/workload/activity; self `GET /staff/analytics`. Keep public projections whitelisted; staff reads only through authorized, audited endpoints.

## Deploy shape

`render.yaml`: service `usvc-api`, `rootDir: usvc-backend`, `npm ci && npm run build` / `npm run start`, `/health` check, Node 24. YAML holds non-secret defaults; secrets (`sync: false`) set in dashboard: `MONGODB_URI`, `MONGODB_DB_NAME`, `FRONTEND_URL` (exact prod origin), JWT secrets, Stripe keys, `STAFF_PORTAL_URL`, `SENSITIVE_ENCRYPTION_KEY` (fresh per env — losing prod key is unrecoverable). Local: `cp .env.example .env`, `npm install`, `npm run dev`. Before real orders: paid Atlas + backups, least-privilege user + IP allow, prod webhook + secret, key isolation, staging `EMAIL_RECIPIENT_OVERRIDE`. Outbox failures inspected in Mongo.

## Shared facts (both repos)

Order milestones: Payment Successful → Order Received → Order Processing → Order Processed (Submitted to Govt Agency); exception `TO_CS` shows neutral message only. Staff flow: `PAID → IN_REVIEW → SUBMITTED` + `IN_REVIEW → TO_CS` (note required, 26-value substatus, auto-releases) → `TO_CS → GTG` → `GTG → IN_REVIEW`. Roles: ADMIN (all), FULFILLMENT (own orders), CS (own + correction + `GTG` + pricing). Invite-only, no self-register; 8+ char passwords; 30m access + 7d rotating refresh; 5 fails/15min lockout. Order numbers `US<ST>-<BT|DT|MG|DV>-<YYYYMMDD>-<DDLDDD>`, opaque everywhere. Pricing cents: copies × $149 + $45 rush; agency/shipping charged later, never in total.
