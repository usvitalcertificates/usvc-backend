# Shared glossary + locked decisions

Single source for facts both repos share. Per-repo files must link here, not copy.

## Order lifecycle (locked 2026-09-23)

Customer-facing milestones (tracker shows only these + neutral exception message):

1. Payment Successful (Stripe-confirmed only)
2. Order Received
3. Order Processing (email update to user)
4. Order Processed — Submitted to the Govt Agency (final; there is no "Completed")

Operational exception state: `TO_CS` (To CS park; the old `On Hold` / `Need Customer Information` labels were removed 2026-09-24). Agent must add an internal note when parking; tracker shows a neutral support message, never internal notes or staff info.

Staff flow: `PAID → IN_REVIEW → SUBMITTED` (terminal), plus `IN_REVIEW → TO_CS` (note required, optional 26-value substatus, auto-releases for CS), `TO_CS → GTG` (CS-owner or ADMIN, note optional, clears substatus, drops ownership), `GTG → IN_REVIEW` (resume). Nothing leaves `TO_CS` except `GTG`. `SUBMITTED` needs completion PDF + ≥1 note (ADMIN bypasses).

## Roles

- `ADMIN` (super-admin): everything — roster, all orders, release/reassign, MFA reset, password resets, audit.
- `FULFILLMENT` (agent/staff): claim and process only own assigned orders.
- `CS`: claims orders, full-form correction (`EDIT`-only), marks `TO_CS → GTG`. Sees pricing (like ADMIN); FULFILLMENT does not.
- Staff accounts are invite-only. No self-register. Login = email + password, then TOTP code. 8+ char self-set passwords; 30m access + 7d rotating refresh; 30-min inactivity sign-out (frontend timer; not backend-enforced); 5 fails/15min lockout. Lost device: super-admin MFA reset (revokes sessions, audited) + recovery codes (still open, Phase 3 proposal).

## Order numbers

Plate format `US<ST>-<BT|DT|MG|DV>-<YYYYMMDD>-<DDLDDD>` (e.g. `USCA-BT-20260922-00A001`, sequential `00A001 → 00A999 → 00B001…`, capacity 2,597,400) from atomic `counters.orderSeq`. Treat as opaque string everywhere (tracking, emails, GA4, Stripe metadata). Pre-launch wipe resets counter.

## Pricing (two-fee model)

Server-authoritative integer cents: `copies × $149 + ($45 rush if selected)`. Government/agency/shipping fees are charged separately later and never enter the order total. Browser `totalCents` is display-only; mismatch → 422.

## Sensitive order fields (policy TBD — pending owner decision)

Orders carry payment/identity fields whose storage, encryption, and staff-access policy is undecided. See code, not docs. Do not document storage mechanics, formats, or risk judgments here until the decision lands.

- Audit everything: invite, login success/failure, MFA enroll/reset, claim/release/reassign, status transition, notes, document upload/download/delete, password resets.

## Scope locks

- Payments: Stripe Checkout Sessions (`ui_mode: elements`) — single charge path. No custody/vault/second-charge.
- DB/Auth: Express + Mongo/Mongoose + JWT + TOTP. No second DB without migration plan. No Supabase/Postgres rewrite.
- No extra plan/roadmap docs beyond `docs/status.md` + the topic files here.
