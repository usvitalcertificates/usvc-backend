# Current backend status

Last updated: 2026-09-21 (plaintext SSN per owner decision; vault removed; verified E2E vs local Mongo; birth-form requirements; legacy name-history fields removed).

## Implemented

- Mongoose models (`src/models/`): Order (applicant, per-cert subject/family, 3 addresses, geo, copies 1–20, consents + signature, pricing snapshot, plaintext `requestorSsn` + `paymentCard` per owner decision), StaffUser, StripeEvent, GovernmentFee, AttendanceRecord. No vault; `mongodb` driver removed.
- `POST /orders` full contract with Zod + per-cert required maps + county→city geo validation + honeypot/timing anti-abuse + server-recomputed totals. Legacy name-history and alternate-spelling subject fields are not accepted from the public frontend. SSN stored as plaintext on the order per owner requirement; public projections whitelist-exclude it (tested).
- Birth orders require a valid SSN and subject suffix; a Female recorded gender requires the subject maiden last name. Applicant middle name is accepted and persisted as optional data.
- `POST /orders/verify-before-payment` (dry run), `GET /orders/geo/:stateCode`, staff login, tracking lookup (SSN/card-safe projection), signed idempotent Stripe webhooks via Mongoose transactions.
- Checkout Sessions: `GET /orders/checkout-config`, `GET /orders/:id/summary` (whitelisted), `POST /orders/:id/checkout-session` (create/reuse, server total, 3 line items), `POST /orders/checkout-session/confirm` (Stripe-verified paid marking). PaymentIntent endpoint removed. Real $238 test payment verified end to end (embedded tabs → paid receipt, PAID/PAID + intent + audit).
- 16 unit tests; E2E verified: two-fee totals (1-copy $125, 20-copy rush $2,530), 21-copy rejection, Visa/MC + 3-digit CVV enforcement, CA-birth SSN/DOB requirement, payment-authorization consent + Other enforcement.

- MongoDB Atlas connection using the official Node.js driver and Stable API settings.
- Collections: `staff_users`, `orders`, `stripe_events`, `government_fees`, and `attendance_records`.
- Unique/query indexes for staff email, public order number, Stripe PaymentIntent ID, fee configuration, attendance records, order tracking, and status queues.
- Auth login, order creation, PaymentIntent creation, tracking lookup, signed Stripe webhook intake, and idempotent webhook processing.

## In progress / not yet exposed as routes

- Refresh/logout, invitation acceptance, password setup, and TOTP MFA.
- Staff authorization middleware and protected fulfillment, fee, report, and attendance endpoints.
- Confirmation emails, analytics outbox, admin UI support, and more restrictive public tracking projection.

## Sensitive-data boundary

Never store PAN, CVV, full card expiry, or raw Stripe credentials. The frontend application form may display an SSN field for parity with the reference UI, but the current frontend deliberately excludes that value from the API request. It must not be persisted until a separately designed, lawful, encrypted workflow is approved.
