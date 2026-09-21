# USVC backend

The USVC backend is an Express 5 API written in TypeScript. It persists orders, staff users, Stripe event records, government fees, and attendance records in MongoDB Atlas via the official MongoDB Node.js driver.

## Current implementation

- Health check, security headers, CORS allowlist, request-size limit, and global rate limiting.
- Staff email/password login with Argon2 password verification and JWT access/refresh tokens.
- Order creation with server-authoritative, integer-cent pricing.
- Stripe PaymentIntent creation.
- Signed, idempotent Stripe webhook handling using an Atlas transaction.
- Public order lookup by public order number and customer email.
- MongoDB startup indexes for staff email, order number, payment intent, fees, and attendance.

Staff administration, invitations, refresh/logout endpoints, MFA enrollment, fulfillment queues, fee-management screens, reporting, and attendance APIs are planned; do not describe them as live until their routes and tests exist.

## Requirements

- Node.js 26.9.0 or later (as declared in `package.json`).
- A MongoDB Atlas cluster or another MongoDB replica set. Replica-set support is required for webhook transactions.
- Stripe test keys for local development.

## Run locally

```bash
cp .env.example .env
npm install
npm run dev
```

The API listens on `http://localhost:4000` by default. Confirm it with `GET /health`.

Documentation:

- [Local development](docs/LOCAL_DEVELOPMENT.md)
- [API reference](docs/API.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Architecture decisions](docs/DECISIONS.md)
- [Current status and data boundaries](docs/CURRENT_STATUS.md)
# usvc-backend
