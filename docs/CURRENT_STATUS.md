# Current backend status

Last updated: 2026-09-23 (Node.js 24 LTS; AES-256-GCM confidentialData; staff auth + fulfillment MVP; invitation emails via outbox; queue certificate/openOnly filters).

## Implemented

- Mongoose models (`src/models/`): Order (applicant, per-cert subject/family, 3 addresses, geo, copies 1–20, consents + signature, pricing snapshot, `assignedTo`, encrypted `confidentialData` with `ssnEnc` + `cardNumberEnc`/`cardExpiryEnc`/`cardCvcEnc` + `keyId`/`encryptedAt`). No plaintext SSN or card fields; `mongodb` driver removed.
- `POST /orders` full contract with Zod + per-cert required maps + county→city geo validation + server-recomputed totals. Legacy name-history, alternate-spelling, and requestor previous-last-name fields are not accepted from the public frontend. SSN and card input are encrypted (AES-256-GCM via `SENSITIVE_ENCRYPTION_KEY`) before persistence; SSN must be 9 plausible digits (area/group/serial rules) and phone must be E.164 international format (`+` + country code + number); public projections whitelist-exclude all of `confidentialData` (tested).
- The California counties San Francisco, San Bernardino, Yolo, Riverside, Del Norte, Lake, Sutter, Kings, and Santa Barbara are temporarily unavailable. They are rejected before an order is created or verified and rechecked before Stripe Checkout Session creation for unpaid existing orders.
- Birth orders require a valid SSN and subject suffix; a Female recorded gender requires the subject maiden last name. Applicant middle name is accepted and persisted as optional data.
- `POST /orders/verify-before-payment` (dry run), `GET /orders/geo/:stateCode`, staff login, tracking lookup (`confidentialData`-safe projection), signed idempotent Stripe webhooks via Mongoose transactions.
- Staff-only `POST /orders/:id/reveal` (per-field SSN/card, reason required, assigned-agent or super-admin, rate-limited, audit-logged) and `GET /orders/:id/audit` (same authorization). Frontend shows `*********` until reveal; no last-4 or brand stored.
- Public order numbers are globally sequential plate codes (`US<state>-<type>-<YYYYMMDD>-<DDLetterDDD>`, e.g. `USCA-BT-20260922-00A001`) from an atomic `counters.orderSeq`; duplicate-key conflicts retry with the next sequence. Tracking and all other consumers treat the number as an opaque string.
- Payment-confirmation email branches on rush: shared "Your application will be reviewed." line, standard workflow paragraph normally, Rush-channel paragraph when rush was paid. All emails use the light logo via direct `usvc-logo-light.png` URL (135KB vs the 1MB dark logo).
- `render.yaml` declares `SENSITIVE_ENCRYPTION_KEY` (secret, `sync: false`) and `SENSITIVE_KEY_ID=v1`; set a fresh key per Render environment (staging + production) via the dashboard — see `DEPLOYMENT.md`.
- Public tracking returns only a customer-safe timeline: Payment Successful, Order Received, Order Processing, and Order Processed – Submitted to the Govt Agency (final step). Stripe webhook payment confirmation creates the first two milestones; authenticated staff can move paid orders forward one fulfillment step at a time through the staff status endpoint (`PAID → IN_REVIEW → SUBMITTED`, plus note-required `ON_HOLD` / `NEED_INFO` park-and-resume; exceptions show a neutral support message publicly).
- Paid Stripe webhooks atomically queue one Resend confirmation per order in `email_outbox`. The background worker leases jobs, uses provider idempotency, retries temporary failures with exponential backoff, and records sanitized delivery audit events.
- When production analytics is enabled, paid Stripe webhooks atomically queue one GA4 Purchase in `analytics_purchase_deliveries`. The worker sends only public order number, charged amount, USD, certificate type, state code, copies, and rush status; it retries safely and records sanitized order audit events. Browser tracking never emits Purchase.
- All Resend HTML emails display the public USVC logo in a shared branded header. Inbox sender-avatar display remains controlled by recipient email clients and requires owner-managed BIMI and/or Apple Branded Mail verification.
- `POST /contact-messages` validates and stores contact inquiries indefinitely in `contact_messages`. It has a contact-only honeypot, minimum completion time, and five-per-15-minute IP limit. Each accepted message atomically queues one support notification and one customer receipt through the same durable Resend outbox; likely SSN/card content is flagged but not blocked.
- Checkout Sessions: `GET /orders/checkout-config`, `GET /orders/:id/summary` (whitelisted), `POST /orders/:id/checkout-session` (create/reuse, server total, 3 line items), `POST /orders/checkout-session/confirm` (Stripe-verified paid marking). PaymentIntent endpoint removed. Real $238 test payment verified end to end (embedded tabs → paid receipt, PAID/PAID + intent + audit).
- 16 unit tests; E2E verified: two-fee totals (1-copy $125, 20-copy rush $2,530), 21-copy rejection, Visa/MC + 3-digit CVV enforcement, CA-birth SSN/DOB requirement, payment-authorization consent + Other enforcement.

- MongoDB Atlas connection using the official Node.js driver and Stable API settings.
- Collections: `staff_users`, `orders`, `contact_messages`, `stripe_events`, `email_outbox`, `government_fees`, and `attendance_records`.
- Unique/query indexes for staff email, public order number, Stripe PaymentIntent ID, fee configuration, attendance records, order tracking, and status queues.
- Auth login, order creation, PaymentIntent creation, tracking lookup, signed Stripe webhook intake, and idempotent webhook processing.

## In progress / not yet exposed as routes

- Fee, report, and attendance endpoints.
- Invitation email delivery via the Resend outbox (setup link is returned in the invite response until templates land).

## Sensitive-data boundary

SSN and card details exist only as AES-256-GCM ciphertext in `confidentialData`, encrypted with `SENSITIVE_ENCRYPTION_KEY` (backend env, never committed). They are never stored as plaintext, never logged, and never returned by public tracking/confirmation/summary projections (tested). Staff reads require `POST /orders/:id/reveal` authorization (assigned agent or super-admin) with a recorded reason. Storing PANs and especially security codes — even encrypted — triggers full PCI-DSS scope per owner-accepted risk (see DECISIONS.md).
