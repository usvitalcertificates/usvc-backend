# Backend status + remaining work

Last updated: 2026-10-02. Phase 1 (public APIs) and Phase 2 (staff MVP) built.

## Implemented

- Orders: full Zod-validated contract, server-cent pricing (`$149/copy + $45 rush`) + `assignedTo`, verify-before-payment, geo datasets (59 states, 9 CA counties blocked), Checkout Sessions (`ui_mode: elements`), idempotent Stripe webhooks with transaction-safe outboxes (Resend confirmation, GA4 purchase, OpenAI conversion with unconditional SHA-256 email hash), customer-safe tracking timeline, plate order numbers (`counters.orderSeq`). Consents are 6 required statements (legacy DB rows may still carry removed keys).
- Straight-through payment (2026-10-02, owner-directed): `POST /orders` charges the service fee synchronously via `lib/direct-charge.ts` (server-side PaymentMethod + confirm PaymentIntent off the stored card, server-computed amount, per-order idempotency key) and returns `{paid}` in the same response — 402 + `paymentCard.number` error on decline/3DS, 502 on processor failure, order marked PAID/FAILED with audit. Webhook `payment_intent.succeeded` converges idempotently (emails/analytics ride it as before). Visa/Mastercard only (existing validation). Processor messages never reach the UI (code-mapped controlled texts). `verify-before-payment` never receives the card (`requireCard:false`) so PAN travels exactly once. Declines log sanitized processor detail (code + Stripe message, never PAN) to the backend terminal. Hybrid token path: browser-minted `tok_` preferred (needs dashboard tokenization surface), raw-PAN Stripe APIs as automatic fallback (needs test-mode raw API access). Pre-launch hardening: `POST /orders` + verify rate-limited (20/60 per 15m per IP); `PAYMENT_ENVIRONMENT` fail-safe (live requires live keys, test rejects live keys). Retry-reuse: `submissionKey` (sparse unique) makes retries update the unpaid order instead of duplicating; paid retry returns 409 to the existing confirmation; staff queue already paid-only. Follow-up (note only): nightly cleanup of abandoned unpaid orders. Unit-tested (135 green).
- Staff: invite-only TOTP auth (lockout, refresh rotation, revoke), masked FIFO queue + atomic claim/release/reassign, owner-or-ADMIN detail/notes/status/documents, `TO_CS`/`GTG` lane with 26-value substatus, CS full-form correction, GridFS completion PDF, ADMIN roster/analytics/workload/activity, self `GET /staff/analytics`, password management.
- Tests green; `npm run build` clean.
- Birth USVR parity (fields only): required subject middleName/sex/maiden/stillLiving; requestor DOB required for all BIRTH; birth event window 1906..90-days-ago; Father+Unknown rejected; applicant suffix stored on the order; CS correction schema/merge and `validateCorrection` mirror the same birth rules. Birth subject maiden name is required only when the recorded gender is Female (hidden for Male on the form). Death requires subject middleName/sex and requestor DOB (submission + correction); race stays optional; no death date-window enforcement (notice only). Marriage requires per-spouse gender + maiden names and requestor DOB (submission + correction). Divorce requires date of divorce, per-spouse gender + maiden names, and requestor DOB (submission + correction). Pricing/delivery model unchanged.

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
