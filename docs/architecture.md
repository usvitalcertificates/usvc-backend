# usvc-backend architecture

## Wiring (`src/`)

- `server.ts`: `connectDb()` → staff-role migration (`STAFF`→`FULFILLMENT`, revoke sessions) → `app.listen` (`:4000`) → start email/GA4/OpenAI outbox workers. (No separate index bootstrap — indexes come from Mongoose schemas.)
- `app.ts`: `helmet()`, `cors({origin: FRONTEND_URL, credentials: true})` (exact, never `*`), `trust proxy 1`, `x-request-id`, `GET /health`, `/webhooks` with `express.raw({type:application/json})` **before** `express.json({limit:100kb})`. Mounts: `/auth`, `/admin`, `/staff`, `/contact-messages`, `/orders`. JSON error handler.
- `types/express.d.ts`: `req.id`. `data/geo/` (59 state/territory JSONs) copied to `dist/data/geo` on build.

## Models (`src/models/`, Mongoose only)

- `order.ts` (`orders`): applicant, per-cert subject/family (Maps), 3 addresses, geo, copies 1–20, consents + signature, pricing snapshot + `amountCents`, `assignedTo: ObjectId|null`, `confidentialData {ssnEnc, cardNumberEnc, cardExpiryEnc, cardCvcEnc, keyId, encryptedAt}` (ciphertext, never indexed, never in default projections), `analytics {clientId, sessionId, openAiEventId, oppref, obref}`, `status {DRAFT,AWAITING_PAYMENT,PAID,IN_REVIEW,TO_CS,GTG,SUBMITTED,CANCELLED}` + `paymentStatus` + `substatus` (26-value `TO_CS` list), `document` (GridFS `order_docs` bucket fileId), `customerTimeline`, `stripe*Ids`, `notes[]`, `auditEvents[]`. Dead states: `DRAFT`/`CANCELLED` exist in the enum but no transition produces them; `REFUNDED`/`FAILED` payment states surface only in tracking.
- `staff.ts`: `staff_users {email unique, passwordHash Argon2, role ADMIN|FULFILLMENT|CS, accountStatus pending|active|disabled|blocked, inviteTokenHash sha256 48h, mfaSecret (encrypted), mfaEnabled, refreshTokenHash, sessionsRevokedAt, failedLoginAttempts/lockedUntil}` + `stripe_events {_id=eventId}` + `government_fees` + `attendance_records` (fee/attendance schemas ship, but no endpoints serve them yet — see `status.md`).
- `counter.ts` (`counters.orderSeq`), `email-outbox.ts` (`email_outbox` leased jobs), `analytics-purchase-delivery.ts`, `openai-conversion-delivery.ts`, `contact-message.ts`.

## Lib (`src/lib/` + co-located `*.test.ts`, `npm test` green — 18 files)

Pricing/validation: `orders.ts` (`priceOrder = copies*14900 + rush?4500:0`, `encodeSequence`, plate numbers), `order-validation.ts` (488 lines: per-cert maps, county→city, 9 CA counties blocked, SSN plausibility area/group/serial, E.164 `+` phone, copies 1–20, total mismatch → 422), `order-substatus.ts`, `order-document.ts` (GridFS PDF, 10MB, `%PDF-` magic bytes), `customer-tracking.ts` (customer-safe timeline).

Crypto/auth/queue: `crypto.ts` (AES-256-GCM, 12B IV, `v1.<keyId>.<iv>.<ct>.<tag>` base64; empty stays empty; throws on tamper/version/key mismatch), `staff-auth.ts`, `staff-roles.ts` (`canSeePricing/canCorrectOrders` = ADMIN+CS), `staff-role-migration.ts`, `staff-queue.ts` (FIFO `createdAt`, `attentionFirst`, masked rows), `admin-staff-analytics.ts` (actor-event KPIs, date/workflow filters).

Email/analytics: `email-outbox.ts` (leased retries, idempotency keys), `staff-email.ts`, `payment-confirmation-email.ts` (rush-branch copy, text-only, no `<img>`), `submission-notification-email.ts`, `contact-email.ts` + `contact-validation.ts`, `analytics-purchase.ts` + `analytics-outbox.ts`, `openai-conversion.ts` + `openai-conversion-outbox.ts`.

## Middleware + config

- `middleware/auth.ts`: `requireAuth` (Bearer JWT) → `requireActiveStaff` (refuses disabled/blocked + pre-revocation tokens, touches `lastActivityAt`) → `requireAdmin` (`role==ADMIN`). 5-fail/15m lockout, 10m MFA token, 30m access + 7d rotating refresh. Coverage note: `requireActiveStaff` gates `/staff/*` and `/admin/*`, but the `orders.ts` staff endpoints (reveal/audit/status/document) check `requireAuth` alone — see `status.md` backlog.
- `config/env.ts`: Zod-parsed, fail-closed (prefix checks `mongodb`, `sk_`, `whsec_`, `pk_`, `re_`, `G-`; requires Resend set when `EMAIL_ENABLED=true`, GA4 when `ANALYTICS_ENABLED=true`, OpenAI when enabled).

## Auth matrix (see `staff-api.md` for route table)

Public (no token): `/health`, contact, order create/verify/geo/checkout-config/summary/checkout-session/confirm, tracking, `/webhooks/stripe` (signature), `/auth/login|mfa/*|setup`, `/auth/refresh`. Active staff (`/staff/*`): queue, claim/release, own-order detail/notes, `GET /staff/analytics` (self from token). Owner-or-ADMIN: detail/notes plus `orders.ts` reveal/audit/status/document (auth-only — see coverage note above). CS extras: queue visibility for all paid orders, inbox correction + `GTG` authority + pricing (no separate inbox route). ADMIN-only: `/auth/invite*`, `/auth/password` (self-change), `/admin/*`, reassign, password-reset, MFA-reset, revoke, staff patch.

## Deploy shape

`render.yaml`: service `usvc-api`, `rootDir: usvc-backend`, `npm ci && npm run build` / `npm run start`, `/health` check, Node 24. YAML holds non-secret defaults; secrets (`sync:false`) set in dashboard. See `workflows.md`.
