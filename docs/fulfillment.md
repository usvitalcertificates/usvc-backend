# Fulfillment — backend part (extracted from FULFILLMENT_CENTER_PLAN.md)

> Source: former global `FULFILLMENT_CENTER_PLAN.md` (deleted after split). Frontend part → `usvc-frontend` repo `docs/fulfillment.md`. Shared milestones/roles/crypto → `shared-glossary.md`.

## Goal

Restricted internal fulfillment portal: staff claim paid orders and complete the operational workflow; super-admin sees all orders, staff activity, progress, audit history. Subdomain is operational separation only; backend enforces access control on every request.

## Staff accounts + security (backend)

Invite-only; member sets own password + enrolls own TOTP. Two roles to start: ADMIN (all orders, audit, release/reassign, recovery) and Agent/staff (own assigned orders only). Login = email + TOTP. Recovery: codes (open, Phase 3) + ADMIN MFA-reset (revokes sessions, audited). MFA reset + session revoke + audit are built.

## Queue + ownership (backend)

Paid unassigned orders in shared queue. Claim is exclusive + atomic (`findOneAndUpdate {assignedTo: null, PAID}`; 409 otherwise). After claim, only owner (non-admin) can open detail or progress status. ADMIN can view all, release, reassign, review workload.

## Storage model (backend)

- Drop plaintext `requestorSsn`, `paymentCard.{number,expiry,securityCode}`; no `ssnLast4`/`cardLast4`/`cardBrand`; no dual-read.
- `assignedTo: ObjectId | null`; `confidentialData: { ssnEnc, cardNumberEnc, cardExpiryEnc, cardCvcEnc, keyId, encryptedAt }` (ciphertext, never indexed, never in default projections). Lists/details show `*********`; last-4/brand only after reveal.
- Crypto: AES-256-GCM, 12B IV, `v1:<keyId>:<base64 iv>:<base64 ct>:<base64 tag>`. Key `SENSITIVE_ENCRYPTION_KEY` (Render secret, `SENSITIVE_KEY_ID=v1`); fail-closed startup. No real key in repo/docs/logs/analytics.
- Encrypt at `POST /orders` after Zod + pricing validation, before `Order.create`. Never persist/log plaintext. Response `{id, publicNumber, amountCents}`.
- Pre-launch wipe: owner deletes all existing orders (incl. owner-controlled backups) before go-live. Old plaintext fields not read.
- SSN: `confidentialData.ssnEnc` only. Card (PAN+EXPIRY+CVV): `confidentialData.*Enc` only — owner-accepted PCI risk (full PCI-DSS scope, processor/fine exposure for separate gov-agency payment).

## Reveal endpoint (backend)

`POST /orders/:id/reveal {field: ssn|card, reason}`: `requireAuth`; ADMIN or `order.assignedTo == user.sub` only; rate-limit (10/15min per IP+user). Returns plaintext once; appends immutable `auditEvents {action: reveal, actorId, field, reason, at}`; never logs values. `GET /orders/:id/audit` owner-or-admin only.

## Audit + privacy (backend)

Immutable sanitized events: invite, login success/failure, MFA enroll/reset, claim/release/reassign, status transition, notes, reveals. Never write SSN/card/CVV/passwords/MFA secrets/decrypted values to logs, notes, analytics, or audit details. Public tracking = public metadata + customer-safe history only.

## Execution record (backend)

- Phase 1 (encryption, built): `lib/crypto.ts` (+ roundtrip/tamper tests), `config/env.ts` + `.env.example` (fail-closed), `models/order.ts` (`assignedTo` + `confidentialData`), `routes/orders.ts` (encrypt at creation, whitelisted projections, reveal + audit endpoints). Docs + `API.md` reveal contract. Proof: birth order E2E → Atlas `*Enc` only → admin reveal + audit.
- Phase 2 (staff portal, built 2026-09-23): TOTP auth (lockout, refresh rotation, revoke), masked queue + atomic claim + filters + pagination, My Work / Closed / Search, tabbed detail, per-field reveal + reason + 30s mask, exception statuses + note rule, invitation outbox (+ resend), roster + workload + day-grouped timeline, settings. 52 tests green. Two bugs fixed (notes 500; audit-wipe → atomic updates).
- Phase 3 (runway): merge PRs → `develop` → staging (override inbox; keep staging orders; ≥1 paid test order) → hardening (payment go-live isolation + runbook, anti-abuse, confirmation-receipt endpoint, SEO, receipt parity, outbox visibility, audit retention + backup drill) → pre-launch wipe + seed + go-live on `flow.` → deferred (gov-fee CRUD, sales/revenue, attendance, Tasks, Documents tab/Center, Test Orders) → proposed awaiting owner (agency-payment confirmation field, read-only gov-fee reference, recovery codes, `Need Customer Information` outreach procedure, SLA escalation, saved filters + CSV + print sheet).
