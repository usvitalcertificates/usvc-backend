# Backend status + remaining work

Last updated: 2026-10-20. Phase 1 (public APIs) and Phase 2 (staff MVP) built.

## Implemented

- Orders: full Zod-validated contract, server-cent pricing (`$149/copy + $12 rush`) + `assignedTo`, verify-before-payment, geo datasets (59 states, 9 CA counties blocked), Checkout Sessions (`ui_mode: elements`), idempotent Stripe webhooks with transaction-safe outboxes (Resend confirmation, GA4 purchase, OpenAI conversion with unconditional SHA-256 email hash), customer-safe tracking timeline, plate order numbers (`counters.orderSeq`). Consents are 6 required statements (legacy DB rows may still carry removed keys).
- Straight-through payment (2026-10-02, owner-directed): `POST /orders` charges the service fee synchronously via `lib/direct-charge.ts` (server-side PaymentMethod + confirm PaymentIntent off the stored card, server-computed amount, per-order idempotency key) and returns `{paid}` in the same response — 402 + `paymentCard.number` error on decline/3DS, 502 on processor failure, order marked PAID/FAILED with audit. Webhook `payment_intent.succeeded` converges idempotently (emails/analytics ride it as before). Visa/Mastercard only (existing validation). Processor messages never reach the UI (code-mapped controlled texts). `verify-before-payment` never receives the card (`requireCard:false`) so PAN travels exactly once. Declines log sanitized processor detail (code + Stripe message, never PAN) to the backend terminal. Hybrid token path: browser-minted `tok_` preferred (needs dashboard tokenization surface), raw-PAN Stripe APIs as automatic fallback (needs test-mode raw API access). Idempotency keys are scoped per charge attempt (atomic `chargeAttempts` counter) so retries with fresh single-use tokens never collide; idempotency errors map to a retryable 502. Pre-launch hardening: `POST /orders` + verify rate-limited (20/60 per 15m per IP); `PAYMENT_ENVIRONMENT` fail-safe (live requires live keys, test rejects live keys). Retry-reuse: `submissionKey` (sparse unique) makes retries update the unpaid order instead of duplicating; paid retry returns 409 to the existing confirmation; staff queue already paid-only. Vermont + Wyoming listed but not orderable: submission validation rejects with a `state` error. Paid-order Google Chat alerts: leased outbox worker posts order number + customer name + flow-portal link to the Space webhook (per-order dedupe across both paid paths). Follow-up (note only): nightly cleanup of abandoned unpaid orders. Unit-tested.
- Staff: invite-only TOTP auth (lockout, refresh rotation, revoke), masked FIFO queue + atomic claim/release/reassign, owner-or-ADMIN detail/notes/status/documents, `TO_CS`/`GTG` lane with 26-value substatus, CS full-form correction, GridFS completion PDF, ADMIN roster/analytics/workload/activity, self `GET /staff/analytics`, password management.
- Tests green; `npm run build` clean.
- Paid-order chat template + device location (2026-10-06): Google Chat notice rebuilt to the exact 5-line template (name uppercased, `Unknown` fallbacks, portal link/flag removed); new keyless ipwho.is resolver (HTTPS, 2.5s timeout, skips private ranges, fail-open) captures device city/region at `POST /orders` charge time into `order.deviceLocation` (city/region strings only — raw IP never stored or logged); outbox snapshot + webhook projection extended (state, certificate, device + shipping locations) so both paid paths render identically. 145/145 tests green.
- Chat bold heading + RUSH + XFF fix (2026-10-06): heading uses Chat `*bold*` markup (`*New Paid Order*`, `*New Paid Order - RUSH*` for rush orders via snapshotted `rush` flag); client IP now read from the leftmost public X-Forwarded-For entry (browser arrives via the Vercel proxy, so `req.ip` alone is a proxy egress IP — the earlier `Unknown` cause); raw IP still never stored. 146/146 tests green; ipwho.is reachability verified live.
- No long dashes in customer copy (2026-10-06): customer email subjects/bodies (payment confirmation, submission notice, contact auto-reply), Stripe receipt/statement strings, and the tracking milestone changed from `—`/`–` to periods/plain `-`/`|`; affected unit tests updated in sync. Staff-only copy, comments, and internal subjects untouched. 140/140 tests green.
- Birth USVR parity (fields only): required subject sex/maiden/stillLiving (middle name optional); requestor DOB required for all BIRTH; birth event window 1906..90-days-ago; Father+Unknown rejected; applicant suffix stored on the order; CS correction schema/merge and `validateCorrection` mirror the same birth rules. Birth subject maiden name is required only when the recorded gender is Female (hidden for Male on the form). Death requires subject sex and requestor DOB (submission + correction), middle name optional; race stays optional; no death date-window enforcement (notice only). Marriage requires per-spouse gender + maiden names and requestor DOB (submission + correction). Divorce requires date of divorce, per-spouse gender + maiden names, and requestor DOB (submission + correction). Pricing/delivery model unchanged.

- Rush fee change (2026-10-17): Rush Processing dropped from $45.00 to $12.00 per order (cents `4500` → `1200`) in `lib/orders.ts` (`priceOrder`), `lib/order-validation.ts` (`pricingBreakdown`), and the Stripe Checkout rush line item (`routes/orders.ts`). Server stays authoritative; stored `pricing.rushCents`/`amountCents` drive staff view, confirmation, and emails. `orders.test.ts` rush expectation updated to `31000` (2 × $149 + $12).

- Payment retry safety (2026-10-20): durable per-order `paymentAttempt` fence shared by direct charges and legacy Checkout; application replacement and retry reservation are atomic. Direct payments create an unconfirmed intent, persist its reference, then confirm with a stable attempt key. Lost responses/crashes reconcile that reference; declined/action-required intents are cancelled and verified before a new attempt. Processing, unavailable, unknown legacy charges, and missing references beyond the 23-hour replay window stay blocked (423 with a customer-safe message, no `orderId` redirect). Open Checkout sessions are reused and block direct payment; expired sessions unlock only with no intent or a confirmed cancelled intent. No production data edits/migration; legacy unpaid rows with previous direct attempts but no fence need operator reconciliation rather than an automatic new charge.
- Payment settlement safety (2026-10-20): direct reconciliation, Stripe webhooks, and Checkout confirmation share ownership/attempt/reference + amount/currency/environment verification and transaction-safe paid updates. Delayed failures cannot replace PAID/REFUNDED; delayed successes preserve staff workflow and original milestone dates. Email/GA4/OpenAI/Chat outboxes enqueue atomically on every paid path with per-order dedupe. Webhooks read current Stripe state and acknowledge only committed event-ID duplicates; DB/outbox failures roll back and remain retryable. Public response projections do not expose attempt state or provider references. Frontend unchanged: its existing generic-error path displays the 423 message and stays on the form. Auth-gap issue remains deferred.
- Payment regression verification: `src/lib/payment-safety.test.ts` exercises real local Mongo replica-set transactions and HTTP routes with fully mocked Stripe (no external charges). Run with `PAYMENT_TEST_MONGODB_URI='mongodb://127.0.0.1:27941/?replicaSet=usvc-payment-safety' npm test`; it uses a uniquely named test database and drops only that database. Without that variable, the integration suite is skipped; payment ownership unit tests always run. Scenarios cover concurrent create/retry, lost create/confirm responses, cancellation races, stale workers, delayed/duplicate events, amount/reference mismatches, transaction rollback, and legacy Checkout isolation. Unresolved legacy charges and aged missing references intentionally require operator investigation against Stripe; do not clear their fence or change payment status manually to force a retry. For rollout, drain old API processes before admitting payment traffic to the new version so old handlers cannot bypass the fence. Existing paid orders need no backfill. Full backend verification passed: 176/176 tests (including the local integration suite), build, format, format:check, lint, and diff whitespace checks.

## Remaining (Phase 3)

Production hardening (before go-live):

- [ ] Payment go-live hardening: `PAYMENT_ENVIRONMENT` + test/live key isolation, livemode assertion, https return-url guard, runbook
- [ ] Anti-abuse: HMAC hash IP/email/order/session + rate-limit order creation
- [ ] `GET /orders/:id/confirmation` — backend-verified paid receipt
- [ ] Outbox failure visibility for super-admin (FAILED jobs currently Mongo-only)
- [ ] Audit retention policy + backup/restore drill

Deferred modules:

- [ ] `GET /government-fees` public read + gov-fee CRUD + audit
- [x] Sales/revenue aggregation endpoints — `GET /admin/orders-summary` ships certificate/state/status/revenue facets (paid orders, date-rangeable); per-agent revenue still open
- [ ] Attendance routes, Tasks system, Documents tab backend
- [ ] Do NOT build custody/vault/second-charge

Chart roadmap (backend `$facet` returns all dimensions in one call — new charts are frontend-only):

- [x] By certificate, by state, certificate×state matrix, by status, totals
- [ ] Orders-over-time series, per-agent throughput/conversion, refund/failed tracking, CSV export endpoint

Proposed — awaiting owner decision:

- [ ] Agency-payment confirmation per order (amount + agency reference)
- [ ] Read-only gov-fee reference for agents
- [ ] Staff TOTP recovery codes (only MFA-reset exists today)
- [ ] `To CS` customer outreach procedure (tracker neutral today)
- [ ] Add `requireActiveStaff` to the 6 `orders.ts` staff endpoints (detail/audit/status/document) — today they check `requireAuth` alone, so a disabled/revoked staffer with an unexpired 30m token can still use them
- [ ] Confirm CS-can-`SUBMITTED` is intended (a CS owner with PDF + note can submit today; only ADMIN bypass is documented)
