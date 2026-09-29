# Backend status + remaining work

Last updated: 2026-09-29. Phase 1 (public APIs) and Phase 2 (staff MVP) are built; fulfillment plan split into `fulfillment.md` (backend) + frontend `docs/fulfillment.md`.

## Implemented (see `architecture.md`, `public-api.md`, `staff-api.md`)

- Orders: full Zod-validated contract, server-cent pricing (`$149/copy + $45 rush`), sensitive-field handling (policy TBD — see `fulfillment.md`) + `assignedTo`, verify-before-payment, geo datasets (59 states, 9 CA counties blocked), Checkout Sessions (`ui_mode: elements`), idempotent Stripe webhooks with transaction-safe outboxes (Resend confirmation, GA4 purchase, OpenAI conversion with consent-gated SHA-256 email matching), customer-safe tracking timeline, plate order numbers (`counters.orderSeq`).
- Staff: invite-only TOTP auth (lockout, refresh rotation, revoke), masked FIFO queue + atomic claim/release/reassign, owner-or-ADMIN detail/notes/status/documents/sensitive-access, `TO_CS`/`GTG` lane with 26-value substatus, CS full-form correction, GridFS completion PDF, ADMIN roster/analytics/workload/activity, self `GET /staff/analytics`, password management.
- 87 tests in 18 files green; `npm run build` clean.

## Remaining (Phase 3)

Production hardening (before go-live):

- [ ] Payment go-live hardening: `PAYMENT_ENVIRONMENT` + test/live key isolation, livemode assertion, https return-url guard, `docs/GO_LIVE.md` runbook
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
- [ ] Add `requireActiveStaff` to the 6 `orders.ts` staff endpoints (reveal/audit/status/document) — today they check `requireAuth` alone, so a disabled/revoked staffer with an unexpired 30m token can still use them (found in docs audit 2026-09-28; docs-first decision: fix code, not docs)
- [ ] Confirm CS-can-`SUBMITTED` is intended (a CS owner with PDF + note can submit today; only ADMIN bypass is documented)

## Doc rule

After any code change, update this file's checkboxes + the matching `docs/` topic file in the same turn. Never log/store customer PII or secrets.

> Scrub note 2026-09-28: SSN/card storage, encryption, reveal, and PCI-risk discussion removed from all docs pending owner decision (see `fulfillment.md` TBD pointer). Do not re-add until the decision lands.
