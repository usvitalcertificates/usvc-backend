# Backend TODO — public funnel first

Scope locked 2026-09-21: Phase 1 = public APIs to Lovable parity. Phase 2 = full staff suite (deferred, not started).

## Phase 1 (do first)

- [x] Full order contract (`POST /orders` validates + stores applicant/subject/family/addresses/geo/consents; copies 1–20; server pricing) — done 2026-09-21, E2E vs local Mongo
- [x] SSN storage: plaintext on order per owner decision 2026-09-21 (vault + crypto + env key removed; test data cleaned; projections verified SSN-safe)
- [x] Payment card storage (Section 8, Visa/MC + Luhn + expiry + CVV, plaintext per owner decision) + copies capped 1–5 — done 2026-09-21, UI E2E all 4 types
- [x] `POST /orders/verify-before-payment` dry-run + `GET /orders/geo/:stateCode` — done 2026-09-21
- [x] Mongoose full switch (driver removed; `src/models/`, `src/lib/db.ts`) — done 2026-09-21
- [x] Geo datasets (`src/data/geo/`, 59 states) + county→city validation — done 2026-09-21
- [ ] `GET /government-fees?state&cert` — public read from `government_fees` collection
- [ ] `GET /orders/:id/confirmation` — backend-verified paid receipt (webhook is authoritative)
- [ ] Harden `POST /orders/tracking` — publicNumber + email only, sanitized projection
- [ ] Anti-abuse: HMAC hash IP/email/order/session + rate-limit order creation
- [ ] Stripe isolation: add `PAYMENT_ENVIRONMENT`, `STRIPE_{LIVE,TEST}_*`, fail-closed prefix checks, 1 live webhook with 3 events
- [ ] Email: Resend/SES order-confirmation send on webhook `succeeded` only (port template)
- [ ] GA4: server purchase outbox + retry endpoint (secret-gated)
- [ ] Proof: `npm run build && npm test` passes

## Phase 2 (deferred)

- [ ] Auth: refresh/logout/invite/accept/password-setup, TOTP enroll/verify, `requireAuth` + `requireRole`
- [ ] Fulfillment: queue/search, detail, status PATCH, notes POST, audit GET
- [ ] Admin: gov-fee CRUD + audit, sales/revenue aggregation
- [ ] Attendance: routes only if needed (original was isolated preview-only)
- [ ] Do NOT build custody/vault/second-charge

## Doc rule

After any code change, update this file's checkboxes + `docs/CURRENT_STATUS.md` in the same turn. Never log/store PAN, CVV, expiry, SSN, or secrets.
