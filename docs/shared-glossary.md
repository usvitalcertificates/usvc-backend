# Shared glossary + locked decisions

Single source for facts both repos share. Per-repo files must link here, not copy.

## Order lifecycle (locked 2026-09-23)

Customer-facing milestones (tracker shows only these + neutral exception message):

1. Payment Successful (Stripe-confirmed only)
2. Order Received
3. Order Processing (email update to user)
4. Order Processed — Submitted to the Govt Agency (final; there is no "Completed")

Operational exception statuses: `On Hold`, `Need Customer Information`. Agent must add an internal note when parking; tracker shows a neutral support message, never internal notes or staff info.

Staff flow: `PAID → IN_REVIEW → SUBMITTED` (terminal), plus `IN_REVIEW → TO_CS` (note required, optional 26-value substatus, auto-releases for CS), `TO_CS → GTG` (CS-owner or ADMIN, note optional, clears substatus, drops ownership), `GTG → IN_REVIEW` (resume). Nothing leaves `TO_CS` except `GTG`. `SUBMITTED` needs completion PDF + ≥1 note (ADMIN bypasses).

## Roles

- `ADMIN` (super-admin): everything — roster, all orders, release/reassign, MFA reset, password resets, audit.
- `FULFILLMENT` (agent/staff): claim and process only own assigned orders.
- `CS`: claims orders, full-form correction (`EDIT`-only), marks `TO_CS → GTG`. Sees pricing (like ADMIN); FULFILLMENT does not.
- Staff accounts are invite-only. No self-register. Login = email + password + TOTP code. 12+ char self-set passwords; 30m access + 7d rotating refresh; 30-min inactivity sign-out; 5 fails/15min lockout. Lost device: super-admin MFA reset (revokes sessions, audited) + recovery codes (still open, Phase 3 proposal).

## Order numbers

Plate format `US<ST>-<BT|DT|MG|DV>-<YYYYMMDD>-<DDLD DD>` (e.g. `USCA-BT-20260922-00A001`) from atomic `counters.orderSeq`. Treat as opaque string everywhere (tracking, emails, GA4, Stripe metadata). Pre-launch wipe resets counter.

## Pricing (two-fee model)

Server-authoritative integer cents: `copies × $149 + ($45 rush if selected)`. Government/agency/shipping fees are charged later via the stored card and never enter the order total. Browser `totalCents` is display-only; mismatch → 422.

## Crypto (locked 2026-09-23)

- AES-256-GCM, random 12-byte IV per field, format `v1:<keyId>:<base64 iv>:<base64 ct>:<base64 tag>`.
- Single `SENSITIVE_ENCRYPTION_KEY` (32 bytes, hex/base64) in backend env / Render secret, id `SENSITIVE_KEY_ID=v1`. Backend fails closed at startup when missing/malformed.
- `confidentialData: { ssnEnc, cardNumberEnc, cardExpiryEnc, cardCvcEnc, keyId, encryptedAt }` on `orders`. No plaintext SSN/card fields, no `ssnLast4`/`cardLast4`/`cardBrand`. Same KEK encrypts TOTP secrets.
- Encrypt at `POST /orders` after Zod + pricing validation, just before `Order.create`. Pre-launch wipe: owner deletes all existing orders (incl. owner-controlled backups) before go-live; no migration.

## Reveal + audit (locked)

- Masked `*********` everywhere by default; no last-4/brand before reveal. Two buttons per order: `Reveal SSN`, `Reveal Card` (no reveal-all). Reason required (`Govt submission` / `Verification` / `Other + text`).
- `POST /orders/:id/reveal {field: ssn|card, reason}`: `requireAuth`, assigned-agent-or-ADMIN only, rate-limited (10/15min per IP+user). Returns plaintext once; appends immutable `auditEvents {action: reveal, actorId, field, reason, at}`; never logs values. `GET /orders/:id/audit` is owner-or-admin only.
- Frontend: 30-second countdown, then auto-mask + wipe from memory (`null`). Tab-hide / route-leave / logout wipes immediately. No localStorage/sessionStorage/analytics/clipboard persistence beyond explicit user copy while visible.
- Audit everything (sanitized, never secrets): invite, login success/failure, MFA enroll/reset, claim/release/reassign, status transition, notes, reveals, document upload/download/delete, password resets.

## Scope locks

- Payments: Stripe Checkout Sessions (`ui_mode: elements`) — single charge path. No custody/vault/second-charge.
- DB/Auth: Express + Mongo/Mongoose + JWT + TOTP. No second DB without migration plan. No Supabase/Postgres rewrite.
- No extra plan/roadmap docs beyond the per-repo `TODO`/`CURRENT_STATUS` equivalents tracked here.
