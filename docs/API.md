# API reference

Base URL in local development: `http://localhost:4000`.

## Live routes

| Method | Path                                   | Purpose                                                                                                                                                                 |
| ------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/health`                              | Returns API health information.                                                                                                                                         |
| POST   | `/auth/login`                          | Staff login. Requires `email` and a password of at least 12 characters. Returns JWT access and refresh tokens.                                                          |
| POST   | `/contact-messages`                    | Stores a public Contact Us inquiry and queues a support notification plus a customer receipt.                                                                           |
| POST   | `/orders`                              | Creates an unpaid order with the full application. Validates per-cert fields, geo, consents, and server-calculated total.                                               |
| POST   | `/orders/verify-before-payment`        | Dry-run validation; returns canonical `amountCents` without writing.                                                                                                    |
| GET    | `/orders/geo/:stateCode?county=&city=` | Validates a county/city pair against the dataset.                                                                                                                       |
| GET    | `/orders/checkout-config`              | Returns the Stripe publishable key (browser-safe).                                                                                                                      |
| GET    | `/orders/:id/summary`                  | Whitelisted order summary for checkout (no SSN/card).                                                                                                                   |
| POST   | `/orders/:id/checkout-session`         | Creates (or reuses) a Stripe Checkout Session (`ui_mode: elements`); server-computed total only.                                                                        |
| POST   | `/orders/checkout-session/confirm`     | Verifies a session with Stripe; marks the order paid.                                                                                                                   |
| POST   | `/orders/:id/reveal`                   | Staff-only audited reveal of SSN or card (`{field: ssn\|card, reason}`); assigned agent or super-admin; rate-limited. Returns plaintext once and audit-logs the reveal. |
| GET    | `/orders/:id/audit`                    | Staff-only audit history for an order; same authorization as reveal. Events never contain secrets.                                                                      |
| POST   | `/orders/tracking`                     | Public lookup by `publicNumber` and `email`.                                                                                                                            |
| POST   | `/webhooks/stripe`                     | Stripe-only signed webhook endpoint. Paid events atomically queue one confirmation email; it is not a browser API.                                                      |

## Order creation contract

`POST /orders` accepts the full application (see `lib/order-validation.ts`
`createOrderSchema`): state slug/code/name, certificate, geo county/city,
reason, applicant, optional `requestorSsn`, per-cert `subject`/`family`,
home/shipping/billing `addresses`, destination type, copies 1–20, rush,
delivery method, consents + payment authorization, signature, card details, and display
`totalCents` (recomputed server-side as processing + rush only; mismatch is rejected with 422).

It returns an order id, a public order number, and the server-calculated `amountCents`. The browser must not supply an amount. SSN and payment-card details are encrypted (AES-256-GCM) into `confidentialData` before persistence and never appear in responses. Staff reveal them only through `POST /orders/:id/reveal` with a recorded reason.

## Contact message contract

`POST /contact-messages` accepts `fullName`, `email`, optional `orderNumber`,
`message`, and a contact-only `antiAbuse` object containing a honeypot and form
start timestamp. The route allows five submissions per IP every 15 minutes.
Likely SSN/card-number content is flagged for staff but does not block the
message. There is intentionally no public endpoint to retrieve messages.

## Security contract

- Application card/SSN fields are encrypted into `confidentialData` at order creation; plaintext values are never logged, drafted, or returned except once via the authorized reveal endpoint. Never send Stripe secrets to these routes.
- The public tracking route only returns the matching order; future hardening should explicitly project a minimal public-safe response.
- Stripe events are stored by event ID so retries cannot update an order twice.
