# Backend decisions

## Express and TypeScript

Express is used because the project owner already has Node.js experience and needs an API that is easy to inspect and extend. TypeScript provides typed request/data boundaries without adopting a framework the owner does not know.

## MongoDB Atlas and Mongoose

MongoDB Atlas is the current managed database. Mongoose is used for all models
(`src/models/`); the raw `mongodb` driver was removed 2026-09-21. Collection
names are unchanged (`staff_users`, `orders`, `stripe_events`,
`government_fees`, `attendance_records`).
Geo datasets live in `src/data/geo/` (copied from reference) and ship to
`dist/data/geo` via the build script.

MongoDB remains appropriate for the current product. PostgreSQL would be a reasonable future alternative only if reporting, relational staff workflows, and cross-table financial controls become significantly more complex. Do not introduce a second database without an explicit migration plan.

## Applicant data and SSN storage (encrypted confidentialData, locked 2026-09-23)

`POST /orders` stores the complete application (applicant, per-cert
subject/family, home/shipping/billing addresses, geo county/city validated
against the dataset, copies 1–20, consents + signature, server-computed
pricing snapshot). `requestorSsn`, when provided, is encrypted with AES-256-GCM
into `confidentialData.ssnEnc` before persistence — no plaintext SSN is stored,
logged, or returned by any public projection.

This replaces the 2026-09-21 plaintext decision (reversed 2026-09-23; pre-launch
wipe, no migration). Earlier AES-256-GCM vault (`order_secrets`, removed with
`lib/crypto.ts` and `SSN_ENCRYPTION_KEY`) is superseded by the new
`src/lib/crypto.ts` + `SENSITIVE_ENCRYPTION_KEY` / `SENSITIVE_KEY_ID` design.

No plaintext `ssnLast4` is kept: staff see `*********` until an audited reveal.
Staff reads require `POST /orders/:id/reveal` authorization (assigned agent or
super-admin) with a recorded reason; the staff portal renders the value with a
30-second countdown bar, then auto-masks and wipes it.

## Payment card storage (encrypted confidentialData, locked 2026-09-23)

Section 8 "Credit Card Details" (number, MM/YY expiry, 3-digit security code;
Visa/Mastercard only, Luhn-checked) is encrypted with AES-256-GCM into
`confidentialData.cardNumberEnc` / `cardExpiryEnc` / `cardCvcEnc` before
persistence — same pattern as SSN, required by the owner for later government
submission + admin access. Copies 1–20 on all forms (owner decision 2026-09-21,
matching the live site FAQ). No plaintext `cardLast4` / `cardBrand` is kept:
staff see `*********` until an audited reveal.

WARNING on record: storing PANs and especially security codes — even encrypted
— violates card-network rules (CVV storage is forbidden outright) and triggers
full PCI-DSS scope, with processor-termination and fine exposure. Owner
explicitly accepted this after the Stripe-vault alternative was offered.
Mitigations: ciphertext-only at rest, card fields excluded from drafts/logs/
analytics and from all public projections (tested); review UI shows a generic
placeholder, never digits.

## Payments

Stripe owns payment credentials. USVC stores Stripe identifiers and permitted order/payment state only. The API verifies webhook signatures and processes webhooks idempotently inside a Mongoose transaction.

Checkout uses Stripe Checkout Sessions (`ui_mode: elements`, embedded tabs) — one charge path only. The older PaymentIntent endpoint was removed to avoid dual charge paths. Session totals are recomputed server-side; open sessions are reused; confirmation always re-reads the session from Stripe. Webhooks handle `payment_intent.*` plus `checkout.session.completed` / `async_payment_failed`, all idempotent by event ID.

## Order numbers (sequential plate format, locked 2026-09-23)

Public order numbers are `US` + 2-letter state code, certificate type code
(`BT`/`DT`/`MG`/`DV`), UTC `YYYYMMDD`, and a globally sequential 6-character
plate suffix (`00A001` → `00A999` → `00B001` …, capacity 2,597,400 through
`99Z999`), e.g. `USCA-BT-20260922-00A001`. The sequence comes from an atomic
MongoDB `counters.orderSeq` increment (safe across concurrent orders and API
instances); a duplicate-key conflict retries with the next sequence. All
consumers (tracking, emails, GA4, Stripe metadata) treat the number as an
opaque string. Pre-launch wipe resets the counter to 1.

## Transactional email

Payment-confirmation email uses Resend and is triggered only by signed Stripe success webhooks, never by the browser redirect. The webhook transaction upserts a unique `payment-confirmation:{orderId}` MongoDB outbox record alongside the paid state. An in-process worker leases and retries delivery, and the same key is sent to Resend as its idempotency key. Staging requires a recipient override; production sends to the applicant email stored on the order.

## Pricing

Pricing is calculated in integer cents on the server. Two-fee model (owner decision 2026-09-21, matching usvitalrecords.org): only the $149/copy Online Processing Fee plus optional $45 rush is charged now (`priceOrder`). Government / agency / shipping fees are charged separately later via the stored card and never enter the order total. The old all-inclusive bundle formula was removed from pricing, sessions, and all UI.

## Staff auth (custom TOTP, locked 2026-09-23)

Invite-only: super-admin `POST /auth/invite` creates a pending STAFF account with
a single-use setup token (sha256-hashed, 48h expiry); the member sets their own
12+ char password via `POST /auth/setup`. Login is two steps: `POST /auth/login`
(email + password, 5-fail/15min lockout) returns a 10-minute MFA token, then
`POST /auth/mfa/enroll|confirm` (first pairing, QR + manual key shown once) or
`POST /auth/mfa/verify` (daily) issues 30m access + 7d rotating refresh JWTs.
TOTP secrets are AES-256-GCM ciphertext at rest (same KEK as confidentialData);
`otpauth` validates with ±1 step drift. `requireActiveStaff` refuses
disabled/blocked accounts and any token issued before `sessionsRevokedAt`
(MFA reset / revoke / disable). MFA reset clears the pairing, revokes sessions,
and is audit-logged. 30-minute inactivity sign-out is enforced by short access
tokens plus the frontend timer.

## Invitation emails (locked 2026-09-23)

`STAFF_INVITATION` reuses the durable Resend outbox (lease/retry, staging
recipient override). The job carries the single-use setup token so the worker
can build `{STAFF_PORTAL_URL}/auth?setup=…`; the token is `$unset` the moment
the email is SENT, and stale jobs (invite re-sent since) are dropped without
retries. Email-enabled envs never return the token in the invite response;
email-disabled envs (local dev) return it for manual setup. `POST
/auth/invite/:id/resend` regenerates the token and re-queues. Audit:
`invitation_emailed/sent/failed` on the staff doc.

## Fulfillment queue and audit (locked 2026-09-23)

Agents see paid unassigned orders plus their own; admins see all. List rows are
masked (requestor first name + last initial, no contact/PII). Claim is an atomic
`findOneAndUpdate {assignedTo: null, PAID}` — exactly one agent wins (409
otherwise). Only the owner-agent or super-admin may open detail, add notes,
reveal, or change status. Statuses: `PAID → IN_REVIEW → SUBMITTED` (terminal)
plus `TO_CS` park from `IN_REVIEW` (internal note required), `TO_CS → GTG`
(CS/ADMIN only), and `GTG → IN_REVIEW` resume — all showing only a neutral
support message on public tracking.
Projection-loaded docs are mutated with atomic `$push`/`$set` (never `save()`),
so audit history is never overwritten. Staff + order audit events merge in
`GET /admin/activity`; `GET /admin/workload` reports active/completed per agent.

## Locked 2026-09-21: scope and boundaries (refreshed 2026-09-23)

- Scope: Phase 1 (public APIs) and Phase 2 (staff MVP) are built; see `docs/TODO.md` Phase 3 for the remaining backlog.
- Payments: Stripe Checkout Sessions (`ui_mode: elements`, embedded tabs) — one charge path only; the older PaymentIntent endpoint was removed.
- DB/Auth: stay Mongo + Mongoose + JWT + TOTP (`otpauth`). No Supabase/Postgres rewrite, no second database without a migration plan.
- Do not build custody/vault/second-charge. Do not over-engineer: no extra plan/roadmap docs beyond `TODO.md`, `CURRENT_STATUS.md`, `DECISIONS.md`, `API.md`.

## Locked 2026-09-25: To-CS substatus

- Parking an order To CS accepts an optional `substatus` from the 26-value MILES-parity list in `src/lib/order-substatus.ts` ("2nd Contact"/"3rd Contact" excluded per owner — single-touch reasons only). The note stays compulsory; the substatus is never required.
- The enum is validated at the API boundary (`staffStatusUpdateSchema`); any substatus on a non-`TO_CS` move is a 422. It is stored on the order (`substatus`, default null), echoed into the `fulfillment_status_updated` audit metadata, cleared on any other move, and returned by the status endpoint. The frontend mirrors the list; the backend enum is the source of truth.

## Locked 2026-09-25: completion PDF

- Each order carries at most one completion PDF, stored in MongoDB GridFS (`order_docs` bucket) — Atlas-hosted like everything else, no new infrastructure (local disk is ephemeral on Render; S3 would need new credentials). Uploads are memory-held, capped at 10 MB, and verified by `%PDF-` magic bytes, not just extension or mimetype.
- `POST/GET/DELETE /orders/:id/document` are owner-agent-or-ADMIN with `document_uploaded/downloaded/deleted` audit events. Fulfillment needs the PDF plus at least one order note on file before `SUBMITTED` (422 otherwise); ADMIN bypasses the gate and CS never submits, so neither is gated.

## Locked 2026-09-25: OpenAI Ads server conversion

- The browser pixel (`oaiq`, production hosts only) and the server Conversions API fire the same `order_created` independently; the server-generated `openAiEventId` persisted at order creation is the shared dedup key.
- Verified-payment webhooks enqueue exactly one delivery per order (`openai_conversion_deliveries`, `$setOnInsert` idempotent) sent by a leased outbox worker with the server-held key. The payload carries only amount, currency, certificate, copies, and optional click/browser refs — never application, contact, payment, or Stripe data. Disabled by default (`OPENAI_CONVERSIONS_ENABLED=false`); enabling requires pixel ID, API key, and source URL (fail-fast env validation).
