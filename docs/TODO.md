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
- [x] OpenAI Ads server conversion 2026-09-25 (`feat/openai-conversions-api`): order create persists a server `openAiEventId` + optional `openAiOppref`/`openAiObref`; verified-payment webhooks enqueue one `order_created` delivery (`openai_conversion_deliveries`, idempotent per order) sent with the Conversions API key by the leased outbox worker; payload builder tested, secrets stay server-side
- [x] Proof: `npm run build && npm test` passes — green 2026-09-23 (52 tests)

## Phase 2 (staff MVP — built 2026-09-23 on `feat/fulfillment-mvp`)

- [x] Auth: invite/accept/password-setup, TOTP enroll/verify/confirm, refresh/logout, lockout, `requireAdmin` + `requireActiveStaff` (session revoke) — done 2026-09-23, E2E vs scratch Atlas DB (invite → setup → enroll → verify → lockout/revoke paths)
- [x] Fulfillment: masked queue/search (`GET /staff/orders`), atomic claim, release/reassign, owner-or-admin detail, notes POST, exception statuses (note-required) over `PATCH /orders/:id/status` (SUBMITTED terminal) — done 2026-09-23, E2E claim → note → IN_REVIEW → ON_HOLD → resume → SUBMITTED + tracking neutral
- [x] Admin: staff roster, disable/revoke/MFA-reset, workload, combined activity feed — done 2026-09-23, E2E verified incl. session-revoke 401
- [x] Invitation emails 2026-09-23: `STAFF_INVITATION` outbox template (`staff-email.ts` render + escaping tests), `STAFF_PORTAL_URL` env (required when `EMAIL_ENABLED=true`), invite queues email and omits token / returns token when email disabled (local dev), `POST /auth/invite/:id/resend` regenerates + drops stale pending jobs, worker redacts `setupToken` after SENT and skips stale jobs; audit `invitation_emailed/sent/failed`
- [x] Queue filters: `certificate` (order-type) + `openOnly` (open vs closed views) — done 2026-09-23
- [x] Queue attention sort 2026-09-23: `attentionFirst` (exceptions → rush → oldest via aggregation) + `rushOnly`; `attentionPriority()` unit-tested
- [x] Strict query flags 2026-09-23: `openOnly`/`attentionFirst`/`rushOnly` accept only explicit truthy tokens (garbage → 400, never silent-true); 10-case filter matrix E2E green on fresh server
- [x] Rate-limit JSON + driver cleanup 2026-09-23: global limiter returns a JSON message like all others (no more parser SyntaxError in UI); `{new:true}` → `returnDocument:"after"` (claim verified E2E, deprecation warning gone)
- [x] Latest-activity ordering 2026-09-23: queue sorts `updatedAt` desc by default (attention bands keep priority, newest first within bands); touching an order bumps it to row 1 (E2E proven)
- [x] Submission email 2026-09-23: `SUBMISSION_NOTIFICATION` template (recall block + next steps + tracking link, escaped, no secrets) queued once on SUBMITTED via idempotent upsert; worker renders through existing pipeline with `submission_email_sent/failed` audit; E2E proven (one job, correct recipient, IN_REVIEW queues nothing)
- [x] Invitation outbox fix 2026-09-23: `select:false` on `setupToken` starved the stale-check, silently deleting every invite — lease now selects it; guard extracted to tested `isInviteJobCurrent()`; scratch-DB proof (leased token present, job current)
- [x] Invitation dispatch nesting fix 2026-09-23: branch lived after the contact lookup and threw before Resend — lifted top-level; decision extracted to tested `resolveStaffInvitation()` (stale/missing/null drop, current sends, never needs contact data)
- [x] Email copy trim 2026-09-24: `STAFF_INVITATION` drops H1 personalization + authorized-staff-only line (render is `{setupUrl}`-only, `resolveStaffInvitation` no longer uses `fullName`); `SUBMISSION_NOTIFICATION` subject → `Your order has been submitted — {publicNumber}`, removes tracking-link line + gov-agency footer, `vary by agency` → `vary by state to state`
- [x] Staff roles 2026-09-24: `ADMIN/FULFILLMENT/CS` (`STAFF` migrated to `FULFILLMENT` on deploy with session revoke); invite accepts `role` (default `FULFILLMENT`); `PATCH /admin/staff/:id` changes role (last-ADMIN guard, self-block, session revoke); `GET /staff/orders/:id` strips `pricing/amountCents` for non `ADMIN/CS`; `PATCH /staff/orders/:id/correction` EDIT-only for CS-owner or ADMIN + CS lane `TO_CS → GTG → IN_REVIEW`; `staff-roles.ts` helpers tested
- [x] Per-staff analytics 2026-09-25: ADMIN-only, date-filtered audit attribution for unique claims, To-CS handoffs, submissions, and total forms handled, with safe workflow-filtered pagination and no application/confidential fields
- [x] Marked-GTG analytics 2026-09-25 (`feat/analytics-marked-gtg`): GTG moves recognized as audit actions with a `markedGtg` KPI and `gtg` workflow filter; KPI cards now describe exactly the filtered rows (metrics follow date + workflow, not dates alone); tested
- [x] Admin activity explorer 2026-09-25: searchable order index with activity totals and sanitized per-order timelines; analytics rows share KPI attribution; self session revoke/MFA reset blocked
- [x] Self-service staff analytics 2026-09-25: token-scoped `/staff/analytics` exposes the shared date/workflow dashboard to every role without allowing cross-user access
- [x] To-CS status 2026-09-24: `ON_HOLD`/`NEED_INFO` removed everywhere, replaced by single `TO_CS` park status (required internal note, `processingAt` timeline key, neutral public message, attention-first); Open Orders filter drops `SUBMITTED`; CS inbox + resume follow `TO_CS`
- [x] GTG status 2026-09-24: `TO_CS → GTG` (CS/ADMIN only, note optional) → `GTG → IN_REVIEW` (owner/ADMIN/CS); nothing leaves `TO_CS` except via `GTG`, `GTG` never submits directly; parked states share neutral tracking + top attention priority; fulfillment sees red `TO_CS` blocker banner, green `GTG` ready banner
- [x] Full-form CS correction 2026-09-24: `PATCH /staff/orders/:id/correction` accepts the whole form (applicant/subject/family/addresses/geo/reason/delivery + SSN/card re-entry); merged values validated via `validateCorrection()` with 422 `{message, errors}` for inline UI errors; SSN/card encrypted + audited by name only; copies/rush/cert/state/pricing locked
- [x] Ownership loop 2026-09-24: queue lists all paid orders to every role (masked rows, gated actions); `TO_CS` auto-releases for CS to claim; CS must own to edit/Mark GTG (ADMIN bypasses); `GTG` drops ownership back to the pool for fulfillment to claim and continue
- [x] Strict ownership 2026-09-24: CS opens only owned orders like fulfillment (detail/notes/audit/status all owner-or-ADMIN; CS extras are inbox + edit + GTG authority + pricing); `csLane` bypass removed
- [x] CS audit access 2026-09-24 (superseded by strict ownership above): `GET /orders/:id/audit` briefly allowed CS, then reverted to owner-or-ADMIN with the rest
- [x] CS queue handoff age 2026-09-24: `GET /staff/orders` derives `sentToCsAt` from the latest `TO_CS` fulfillment-status audit event; later notes and audit activity cannot change queue priority age
- [x] To-CS substatus 2026-09-25 (`feat/admin-analytics-split`): optional MILES-parity reason on the `TO_CS` park (`PATCH /orders/:id/status` accepts `substatus` from a 26-value enum, no 2nd/3rd Contact; 422 elsewhere); stored on the order, echoed in audit metadata, cleared on any other move, returned by the status endpoint; `order-substatus.ts` schema tested
- [x] Substatus in CS surfaces 2026-09-25: `GET /staff/orders` queue projection returns `substatus` so the CS inbox shows it as a red pill inside the correction-note cell
- [x] Completion PDF 2026-09-25 (`feat/order-document-upload`): single PDF per order in GridFS (`order_docs`, 10 MB cap, `%PDF-` magic check, multer memory upload); `POST/GET/DELETE /orders/:id/document` owner-or-ADMIN with `document_uploaded/downloaded/deleted` audit events; SUBMITTED needs the PDF plus at least one existing order note from non-ADMIN (ADMIN bypasses); `order-document.ts` validators tested
- [x] Pricing $149/copy + $45 rush 2026-09-25 (`feat/price-149-45`): `priceOrder`, server recompute, and Stripe line items updated with tests; old unpaid carts auto-reprice at session creation, paid orders untouched
- [x] Queue FIFO sort 2026-09-25 (`feat/queue-fifo-sort`): `GET /staff/orders` sorts oldest-first by `createdAt` (was most-recently-active by `updatedAt`) so fulfillment picks first-come first-served; attention-first path keeps its TO_CS/GTG/rush bands with oldest-first inside each band
- [x] Shared API rate-limit removal 2026-09-24: removed the global 100-requests-per-15-minutes limiter that interrupted normal staff navigation; retained route-specific security limits and account lockout

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
- [ ] `To CS` customer outreach procedure (customer sees only a neutral tracker message today — decide out-of-band process vs built notification before go-live)

## Doc rule

After any code change, update this file's checkboxes + `docs/CURRENT_STATUS.md` in the same turn. Never log/store PAN, CVV, expiry, SSN, or secrets.
