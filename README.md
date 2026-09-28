# USVC backend

Express 5 + TypeScript API backed by MongoDB Atlas via Mongoose. Server-authoritative pricing, invite-only TOTP staff auth, Stripe Checkout Sessions with idempotent webhooks.

## Run locally

```bash
cp .env.example .env # Atlas URI, Stripe test keys
npm install
npm run dev
```

Requires Node.js 24 and a MongoDB replica set. Health: `GET http://localhost:4000/health`.

## AI agents

Start with `AGENTS.md`, then `docs/` (`architecture.md`, `coding-rules.md`, `shared-overview.md`, `shared-glossary.md`, `shared-security.md`, plus `public-api.md` or `staff-api.md`, `workflows.md`, `fulfillment.md`, `status.md`).
