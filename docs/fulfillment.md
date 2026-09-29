# Fulfillment — backend part (extracted from FULFILLMENT_CENTER_PLAN.md)

> Source: former global `FULFILLMENT_CENTER_PLAN.md` (deleted after split). Frontend part → `usvc-frontend` repo `docs/fulfillment.md`. Shared milestones/roles/crypto → `shared-glossary.md`.

## Goal

Restricted internal fulfillment portal: staff claim paid orders and complete the operational workflow; super-admin sees all orders, staff activity, progress, audit history. Subdomain is operational separation only; backend enforces access control on every request.

## Staff accounts + security (backend)

Invite-only; member sets own 8+ char password + enrolls own TOTP. Three roles: ADMIN (all orders, audit, release/reassign, recovery), FULFILLMENT agent and CS (own assigned orders only; CS also corrects forms and marks `GTG`). Login = email + password, then TOTP code. Recovery: codes (open, Phase 3) + ADMIN MFA-reset (revokes sessions, audited). MFA reset + session revoke + audit are built.

## Queue + ownership (backend)

Paid unassigned orders in shared queue. Claim is exclusive + atomic (`findOneAndUpdate {_id, assignedTo: null, paymentStatus: "PAID"}` — note the payment-status field, not `status`; 409 otherwise). After claim, only owner (non-admin) can open detail or progress status. ADMIN can view all, release, reassign, review workload.

## Storage model (backend)

- Order fields are validated with Zod + server-priced before `Order.create`. Never persist or log incoming sensitive values. Creation response stays `{id, publicNumber, amountCents}`.
- Pre-launch wipe: owner deletes all existing orders (incl. owner-controlled backups) before go-live.
- Payment/identity field storage, encryption, and retention policy: TBD — pending owner decision. See code, not docs. Do not document mechanics or risk judgments here.

## Sensitive-data endpoints (backend — policy TBD)

> Handling policy TBD — pending owner decision. See code, not docs.

Sensitive order fields are readable only through authorized, audit-logged staff endpoints (assigned agent or super-admin). Do not document fields, reasons, limits, or storage here until the decision lands. `GET /orders/:id/audit` is owner-or-admin only.

## Audit + privacy (backend)

Immutable sanitized events: invite, login success/failure, MFA enroll/reset, claim/release/reassign, status transition, notes, document upload/download/delete. Never write passwords/MFA secrets/decrypted values to logs, notes, analytics, or audit details. Public tracking = public metadata + customer-safe history only.

## Execution record (backend)

- Phase 1 (order security, built): request validation + server pricing + masked projections + authorized sensitive-data endpoints + audit trail; `config/env.ts` + `.env.example` (fail-closed). Contract in `docs/public-api.md` + `docs/staff-api.md`. Proof: birth order E2E → masked lists → authorized access + audit.
- Phase 2 (staff portal, built 2026-09-23): TOTP auth (lockout, refresh rotation, revoke), masked queue + atomic claim + filters + pagination, My Work / Closed / Search, tabbed detail, controlled sensitive-data actions + auto-mask, exception statuses + note rule, invitation outbox (+ resend), roster + workload + day-grouped timeline, settings. `npm test` green (18 files). Two bugs fixed (notes 500; audit-wipe → atomic updates).
- Phase 3 (runway): merge PRs → `develop` → staging (override inbox; keep staging orders; ≥1 paid test order) → hardening (payment go-live isolation + runbook, anti-abuse, confirmation-receipt endpoint, SEO, receipt parity, outbox visibility, audit retention + backup drill) → pre-launch wipe + seed + go-live on `flow.` → deferred (gov-fee CRUD, sales/revenue, attendance, Tasks, Documents tab/Center, Test Orders) → proposed awaiting owner (agency-payment confirmation field, read-only gov-fee reference, recovery codes, `Need Customer Information` outreach procedure, SLA escalation, saved filters + CSV + print sheet).
