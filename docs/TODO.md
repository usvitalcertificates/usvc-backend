# Backend TODO

Scope: Phase 1 (public APIs) and Phase 2 (staff MVP) are built; PRs `feat/fulfillment-mvp` → `develop` are open. Phase 3 below is the remaining + proposed backlog.

## Phase 1 (do first)

- [x] Full order contract (`POST /orders` validates + stores applicant/subject/family/addresses/geo/consents; copies 1–20; server pricing) — done 2026-09-21, E2E vs local Mongo
- [x] Confidential storage 2026-09-23: AES-256-GCM `confidentialData` (`ssnEnc`, `cardNumberEnc`, `cardExpiryEnc`, `cardCvcEnc`, `keyId`, `encryptedAt`) + `assignedTo`; replaces plaintext `requestorSsn`/`paymentCard` (removed, pre-launch wipe, no migration). Staff see `*********`; reveal is per-field, reason-required, assigned-or-admin, audit-logged.
- [x] Two-fee model (processing-only totals, bundle removed everywhere, copies 1–20, Visa/MC + 3-digit CVV) — done 2026-09-21, UI E2E all 4 types
- [x] Birth-form contract: required SSN/suffix and female maiden-name validation; optional requestor middle name — done 2026-09-21
- [x] Removed legacy name-history and alternate-spelling subject fields from the public order contract — done 2026-09-21
- [x] Removed the legacy requestor previous-last-name field from the public order contract and persistence model — done 2026-09-21
- [x] Temporarily blocked nine California counties during order validation and before Stripe Checkout Session creation — done 2026-09-22
- [x] Render env wiring 2026-09-23: `SENSITIVE_ENCRYPTION_KEY` (`sync: false`) + `SENSITIVE_KEY_ID=v1` in `render.yaml`; `DEPLOYMENT.md` table documents per-environment keys (fresh key per env; production key backed up offline)
- [ ] Payment go-live hardening (→ Phase 3): PAYMENT_ENVIRONMENT + STRIPE_TEST__/STRIPE_LIVE__ isolation with fail-closed checks, livemode assertion on sessions, https return-url guard in live, docs/GO_LIVE.md runbook (dashboard webhook + key-swap + verification + rollback)
- [x] `POST /orders/verify-before-payment` dry-run + `GET /orders/geo/:stateCode` — done 2026-09-21
- [x] Mongoose full switch (driver removed; `src/models/`, `src/lib/db.ts`) — done 2026-09-21
- [x] Geo datasets (`src/data/geo/`, 59 states) + county→city validation — done 2026-09-21
- [ ] `GET /government-fees?state&cert` (→ Phase 3) — public read from `government_fees` collection
- [ ] `GET /orders/:id/confirmation` (→ Phase 3) — backend-verified paid receipt (webhook is authoritative)
- [x] Customer order tracking timeline: sanitized order-number/email lookup, payment milestones, rate limit, and forward-only staff status updates — done 2026-09-22
- [ ] Anti-abuse (→ Phase 3): HMAC hash IP/email/order/session + rate-limit order creation
- [ ] Stripe isolation (→ Phase 3): add `PAYMENT_ENVIRONMENT`, `STRIPE_{LIVE,TEST}_*`, fail-closed prefix checks, 1 live webhook with 3 events
- [x] Email: durable Resend order confirmation queued by paid Stripe webhooks, with provider idempotency, retry leasing, staging recipient override, and branded HTML/text templates — done 2026-09-22
- [x] Contact messages: persistent MongoDB inbox plus resilient support notification/customer receipt emails — done 2026-09-22
- [x] GA4: production-only browser funnel plus durable server-side purchase outbox from signed paid webhooks — done 2026-09-22
- [x] Sequential public order numbers 2026-09-23: `US<state>-<type>-<date>-<plate>` (e.g. `USCA-BT-20260922-00A001`) via atomic `counters.orderSeq` + `encodeSequence` (00A001→00A999→00B001…); duplicate-key retry; live proof sequential + 5-concurrent unique
- [x] Rush/non-rush confirmation copy 2026-09-23 ("reviewed." shared line; Rush channel paragraph when `rushCents > 0`) + light email logo (`usvc-logo-light.png` direct URL)
- [x] Contact validation 2026-09-23: E.164 international phone (`applicant.phone`, `+` + 7–15 digits) + SSN plausibility (area/group/serial rules) with tests
- [x] GA4 state tracking 2026-09-23: `state_code` (+ `certificate`) on server `purchase` via `AnalyticsPurchaseDelivery.stateCode`; `stateCode` added to the checkout summary projection
- [x] Proof: `npm run build && npm test` passes — green 2026-09-23 (52 tests)

## Phase 2 (staff MVP — built 2026-09-23 on `feat/fulfillment-mvp`)

- [x] Auth: invite/accept/password-setup, TOTP enroll/verify/confirm, refresh/logout, lockout, `requireAdmin` + `requireActiveStaff` (session revoke) — done 2026-09-23, E2E vs scratch Atlas DB (invite → setup → enroll → verify → lockout/revoke paths)
- [x] Fulfillment: masked queue/search (`GET /staff/orders`), atomic claim, release/reassign, owner-or-admin detail, notes POST, exception statuses (note-required) over `PATCH /orders/:id/status` (SUBMITTED terminal) — done 2026-09-23, E2E claim → note → IN_REVIEW → ON_HOLD → resume → SUBMITTED + tracking neutral
- [x] Admin: staff roster, disable/revoke/MFA-reset, workload, combined activity feed — done 2026-09-23, E2E verified incl. session-revoke 401
- [x] Invitation emails 2026-09-23: `STAFF_INVITATION` outbox template (`staff-email.ts` render + escaping tests), `STAFF_PORTAL_URL` env (required when `EMAIL_ENABLED=true`), invite queues email and omits token / returns token when email disabled (local dev), `POST /auth/invite/:id/resend` regenerates + drops stale pending jobs, worker redacts `setupToken` after SENT and skips stale jobs; audit `invitation_emailed/sent/failed`
- [x] Queue filters: `certificate` (order-type) + `openOnly` (open vs closed views) — done 2026-09-23

## Phase 3 (remaining + proposed backlog)

Production hardening (do before go-live):

- [ ] Payment go-live hardening: `PAYMENT_ENVIRONMENT` + `STRIPE_TEST__`/`STRIPE_LIVE__` isolation with fail-closed checks, livemode assertion on sessions, https return-url guard in live, `docs/GO_LIVE.md` runbook (dashboard webhook + key-swap + verification + rollback)
- [ ] Anti-abuse: HMAC hash IP/email/order/session + rate-limit order creation (also covers staff-auth brute force beyond current lockout)
- [ ] `GET /orders/:id/confirmation` — backend-verified paid receipt (webhook is authoritative)
- [ ] Outbox failure visibility: surface FAILED email jobs to super-admin (currently visible only via raw Mongo queries)
- [ ] Audit retention policy + backup/restore drill before go-live

Deferred modules:

- [ ] `GET /government-fees?state&cert` public read + gov-fee CRUD + audit
- [ ] Sales/revenue aggregation endpoints
- [ ] Attendance routes (only if needed; original was isolated preview-only)
- [ ] Tasks system (global inbox + per-order tasks) — Phase 3+
- [ ] Documents tab backend (storage + upload + virus-scan design still open)
- [ ] Do NOT build custody/vault/second-charge

Proposed — awaiting owner decision:

- [ ] Agency-payment confirmation per order (amount actually paid + agency reference) to close the manual gov-payment accounting loop
- [ ] Read-only gov-fee reference for agents (static table before full CRUD)
- [ ] Recovery codes for staff TOTP (plan promises them; only MFA-reset exists today)
- [ ] `Need Customer Information` outreach procedure (customer sees only a neutral tracker message today — decide out-of-band process vs built notification before go-live)

## Doc rule

After any code change, update this file's checkboxes + `docs/CURRENT_STATUS.md` in the same turn. Never log/store PAN, CVV, expiry, SSN, or secrets.
