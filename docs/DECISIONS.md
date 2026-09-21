# Backend decisions

## Express and TypeScript

Express is used because the project owner already has Node.js experience and needs an API that is easy to inspect and extend. TypeScript provides typed request/data boundaries without adopting a framework the owner does not know.

## MongoDB Atlas and Mongoose

MongoDB Atlas is the current managed database. Mongoose is used for all models
(`src/models/`); the raw `mongodb` driver was removed 2026-09-21. Collection
names are unchanged (`staff_users`, `orders`, `stripe_events`,
`government_fees`, `attendance_records`) plus new `order_secrets`.
Geo datasets live in `src/data/geo/` (copied from reference) and ship to
`dist/data/geo` via the build script.

MongoDB remains appropriate for the current product. PostgreSQL would be a reasonable future alternative only if reporting, relational staff workflows, and cross-table financial controls become significantly more complex. Do not introduce a second database without an explicit migration plan.

## Applicant data and SSN storage (plaintext per owner decision 2026-09-21)

`POST /orders` stores the complete application (applicant, per-cert
subject/family, home/shipping/billing addresses, geo county/city validated
against the dataset, copies 1–20, consents + signature, server-computed
pricing snapshot). `requestorSsn`, when provided, is stored as plaintext on
the order document — the owner requires it directly accessible for government
formalities and the admin dashboard. This deliberately reverses the earlier
AES-256-GCM vault (`order_secrets`, removed with `lib/crypto.ts` and
`SSN_ENCRYPTION_KEY`).

Consequences accepted by the owner: SSN is readable by anyone with database
access or backups; a projection mistake in a public API would expose it.
Mitigations in place: tracking/confirmation use strict whitelist projections
(verified by test), SSN never in drafts/logs/analytics, Atlas IP whitelist.
Staff reads must be explicitly authorized (Phase 2).

## Payment card storage (plaintext per owner decision 2026-09-21)

Section 8 "Credit Card Details" (number, MM/YY expiry, 3-digit security code;
Visa/Mastercard only, Luhn-checked) is stored as plaintext
`paymentCard` on the order, same pattern as SSN — required by the owner
for later government submission + admin access. Copies 1–20 on all forms
(owner decision 2026-09-21, matching the live site FAQ).

WARNING on record: storing PANs and especially security codes violates
card-network rules (CVV storage is forbidden outright) and triggers full
PCI-DSS scope, with processor-termination and fine exposure. Owner
explicitly accepted this after the Stripe-vault alternative was offered.
Mitigations: card fields excluded from drafts/logs/analytics and from all
public projections (tested); review UI shows last-4 only.

## Payments

Stripe owns payment credentials. USVC stores Stripe identifiers and permitted order/payment state only. The API verifies webhook signatures and processes webhooks idempotently inside a Mongoose transaction.

Checkout uses Stripe Checkout Sessions (`ui_mode: elements`, embedded tabs) — one charge path only. The older PaymentIntent endpoint was removed to avoid dual charge paths. Session totals are recomputed server-side; open sessions are reused; confirmation always re-reads the session from Stripe. Webhooks handle `payment_intent.*` plus `checkout.session.completed` / `async_payment_failed`, all idempotent by event ID.

## Transactional email

Payment-confirmation email uses Resend and is triggered only by signed Stripe success webhooks, never by the browser redirect. The webhook transaction upserts a unique `payment-confirmation:{orderId}` MongoDB outbox record alongside the paid state. An in-process worker leases and retries delivery, and the same key is sent to Resend as its idempotency key. Staging requires a recipient override; production sends to the applicant email stored on the order.

## Pricing

Pricing is calculated in integer cents on the server. Two-fee model (owner decision 2026-09-21, matching usvitalrecords.org): only the $125/copy Online Processing Fee plus optional $30 rush is charged now (`priceOrder`). Government / agency / shipping fees are charged separately later via the stored card and never enter the order total. The old all-inclusive bundle formula was removed from pricing, sessions, and all UI.

## Locked 2026-09-21: scope and boundaries

- Scope: Phase 1 = public APIs first. Phase 2 = full staff suite (deferred). See `docs/TODO.md`.
- Payments: keep PaymentIntent (already built with sig + idempotency + transaction). Do not switch to Checkout Sessions — same UX, extra complexity.
- DB/Auth: stay Mongo + official driver + JWT + TOTP (`otpauth`). No Supabase/Postgres rewrite, no second database without a migration plan.
- Do not build custody/vault/second-charge. Do not over-engineer: no extra plan/roadmap docs beyond `TODO.md`, `CURRENT_STATUS.md`, `DECISIONS.md`, `API.md`.
