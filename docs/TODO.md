# Backend TODO — public funnel first

Scope locked 2026-09-21: Phase 1 = public APIs to Lovable parity. Phase 2 = full staff suite (deferred, not started).

## Phase 1 (do first)

- [x] Full order contract (`POST /orders` validates + stores applicant/subject/family/addresses/geo/consents; copies 1–20; server pricing) — done 2026-09-21, E2E vs local Mongo
- [x] Confidential storage 2026-09-23: AES-256-GCM `confidentialData` (`ssnEnc`, `cardNumberEnc`, `cardExpiryEnc`, `cardCvcEnc`, `keyId`, `encryptedAt`) + `assignedTo`; replaces plaintext `requestorSsn`/`paymentCard` (removed, pre-launch wipe, no migration). Staff see `*********`; reveal is per-field, reason-required, assigned-or-admin, audit-logged.
- [x] Two-fee model (processing-only totals, bundle removed everywhere, copies 1–20, Visa/MC + 3-digit CVV) — done 2026-09-21, UI E2E all 4 types
- [x] Birth-form contract: required SSN/suffix and female maiden-name validation; optional requestor middle name — done 2026-09-21
- [x] Removed legacy name-history and alternate-spelling subject fields from the public order contract — done 2026-09-21
- [x] Removed the legacy requestor previous-last-name field from the public order contract and persistence model — done 2026-09-21
- [x] Temporarily blocked nine California counties during order validation and before Stripe Checkout Session creation — done 2026-09-22
- [x] Render env wiring 2026-09-23: `SENSITIVE_ENCRYPTION_KEY` (`sync: false`) + `SENSITIVE_KEY_ID=v1` in `render.yaml`; `DEPLOYMENT.md` table documents per-environment keys (fresh key per env; production key backed up offline)
- [ ] Payment go-live hardening (deferred): PAYMENT_ENVIRONMENT + STRIPE_TEST__/STRIPE_LIVE__ isolation with fail-closed checks, livemode assertion on sessions, https return-url guard in live, docs/GO_LIVE.md runbook (dashboard webhook + key-swap + verification + rollback)
- [x] `POST /orders/verify-before-payment` dry-run + `GET /orders/geo/:stateCode` — done 2026-09-21
- [x] Mongoose full switch (driver removed; `src/models/`, `src/lib/db.ts`) — done 2026-09-21
- [x] Geo datasets (`src/data/geo/`, 59 states) + county→city validation — done 2026-09-21
- [ ] `GET /government-fees?state&cert` — public read from `government_fees` collection
- [ ] `GET /orders/:id/confirmation` — backend-verified paid receipt (webhook is authoritative)
- [x] Customer order tracking timeline: sanitized order-number/email lookup, payment milestones, rate limit, and forward-only staff status updates — done 2026-09-22
- [ ] Anti-abuse: HMAC hash IP/email/order/session + rate-limit order creation
- [ ] Stripe isolation: add `PAYMENT_ENVIRONMENT`, `STRIPE_{LIVE,TEST}_*`, fail-closed prefix checks, 1 live webhook with 3 events
- [x] Email: durable Resend order confirmation queued by paid Stripe webhooks, with provider idempotency, retry leasing, staging recipient override, and branded HTML/text templates — done 2026-09-22
- [x] Contact messages: persistent MongoDB inbox plus resilient support notification/customer receipt emails — done 2026-09-22
- [x] GA4: production-only browser funnel plus durable server-side purchase outbox from signed paid webhooks — done 2026-09-22
- [x] Sequential public order numbers 2026-09-23: `US<state>-<type>-<date>-<plate>` (e.g. `USCA-BT-20260922-00A001`) via atomic `counters.orderSeq` + `encodeSequence` (00A001→00A999→00B001…); duplicate-key retry; live proof sequential + 5-concurrent unique
- [x] Rush/non-rush confirmation copy 2026-09-23 ("reviewed." shared line; Rush channel paragraph when `rushCents > 0`) + light email logo (`usvc-logo-light.png` direct URL)
- [ ] Proof: `npm run build && npm test` passes

## Phase 2 (deferred)

- [ ] Auth: refresh/logout/invite/accept/password-setup, TOTP enroll/verify, `requireRole` (`requireAuth` + assigned-or-admin reveal/audit done 2026-09-23)
- [ ] Fulfillment: queue/search, detail, notes POST, audit GET, and UI over the staff status PATCH API (SUBMITTED is the terminal status)
- [ ] Admin: gov-fee CRUD + audit, sales/revenue aggregation
- [ ] Attendance: routes only if needed (original was isolated preview-only)
- [ ] Do NOT build custody/vault/second-charge

## Doc rule

After any code change, update this file's checkboxes + `docs/CURRENT_STATUS.md` in the same turn. Never log/store PAN, CVV, expiry, SSN, or secrets.
