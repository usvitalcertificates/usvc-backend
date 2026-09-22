# Current backend status

Last updated: 2026-09-22 (Node.js 24 LTS; plaintext SSN per owner decision; vault removed; verified E2E vs local Mongo; birth-form requirements; temporary California county block).

## Implemented

- Mongoose models (`src/models/`): Order (applicant, per-cert subject/family, 3 addresses, geo, copies 1–20, consents + signature, pricing snapshot, plaintext `requestorSsn` + `paymentCard` per owner decision), StaffUser, StripeEvent, GovernmentFee, AttendanceRecord. No vault; `mongodb` driver removed.
- `POST /orders` full contract with Zod + per-cert required maps + county→city geo validation + server-recomputed totals. Legacy name-history, alternate-spelling, and requestor previous-last-name fields are not accepted from the public frontend. SSN stored as plaintext on the order per owner requirement; public projections whitelist-exclude it (tested).
- The California counties San Francisco, San Bernardino, Yolo, Riverside, Del Norte, Lake, Sutter, Kings, and Santa Barbara are temporarily unavailable. They are rejected before an order is created or verified and rechecked before Stripe Checkout Session creation for unpaid existing orders.
- Birth orders require a valid SSN and subject suffix; a Female recorded gender requires the subject maiden last name. Applicant middle name is accepted and persisted as optional data.
- `POST /orders/verify-before-payment` (dry run), `GET /orders/geo/:stateCode`, staff login, tracking lookup (SSN/card-safe projection), signed idempotent Stripe webhooks via Mongoose transactions.
- Public tracking returns only a customer-safe timeline: Payment Successful, Order Received, Order Processing, Order Processed – Submitted to the Govt Agency, and Order Completed. Stripe webhook payment confirmation creates the first two milestones; authenticated staff can move paid orders forward one fulfillment step at a time through the staff status endpoint.
- Paid Stripe webhooks atomically queue one Resend confirmation per order in `email_outbox`. The background worker leases jobs, uses provider idempotency, retries temporary failures with exponential backoff, and records sanitized delivery audit events.
- When production analytics is enabled, paid Stripe webhooks atomically queue one GA4 Purchase in `analytics_purchase_deliveries`. The worker sends only public order number, charged amount, USD, certificate type, copies, and rush status; it retries safely and records sanitized order audit events. Browser tracking never emits Purchase.
- All Resend HTML emails display the public USVC logo in a shared branded header. Inbox sender-avatar display remains controlled by recipient email clients and requires owner-managed BIMI and/or Apple Branded Mail verification.
- `POST /contact-messages` validates and stores contact inquiries indefinitely in `contact_messages`. It has a contact-only honeypot, minimum completion time, and five-per-15-minute IP limit. Each accepted message atomically queues one support notification and one customer receipt through the same durable Resend outbox; likely SSN/card content is flagged but not blocked.
- Checkout Sessions: `GET /orders/checkout-config`, `GET /orders/:id/summary` (whitelisted), `POST /orders/:id/checkout-session` (create/reuse, server total, 3 line items), `POST /orders/checkout-session/confirm` (Stripe-verified paid marking). PaymentIntent endpoint removed. Real $238 test payment verified end to end (embedded tabs → paid receipt, PAID/PAID + intent + audit).
- 16 unit tests; E2E verified: two-fee totals (1-copy $125, 20-copy rush $2,530), 21-copy rejection, Visa/MC + 3-digit CVV enforcement, CA-birth SSN/DOB requirement, payment-authorization consent + Other enforcement.

- MongoDB Atlas connection using the official Node.js driver and Stable API settings.
- Collections: `staff_users`, `orders`, `contact_messages`, `stripe_events`, `email_outbox`, `government_fees`, and `attendance_records`.
- Unique/query indexes for staff email, public order number, Stripe PaymentIntent ID, fee configuration, attendance records, order tracking, and status queues.
- Auth login, order creation, PaymentIntent creation, tracking lookup, signed Stripe webhook intake, and idempotent webhook processing.

## In progress / not yet exposed as routes

- Refresh/logout, invitation acceptance, password setup, and TOTP MFA.
- Fee, report, and attendance endpoints; a staff fulfillment UI remains to be built over the protected status endpoint.
- Admin UI support and more restrictive public tracking projection.

## Sensitive-data boundary

Never store PAN, CVV, full card expiry, or raw Stripe credentials. The frontend application form may display an SSN field for parity with the reference UI, but the current frontend deliberately excludes that value from the API request. It must not be persisted until a separately designed, lawful, encrypted workflow is approved.
