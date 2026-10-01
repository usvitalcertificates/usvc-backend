# USVC backend

Express 5 + TypeScript API backed by MongoDB Atlas via Mongoose. Server-authoritative pricing, invite-only TOTP staff auth, Stripe Checkout Sessions with idempotent webhooks. Node 24.

```bash
cp .env.example .env # Atlas URI, Stripe test keys
npm install
npm run dev
```

Health: `GET http://localhost:4000/health`.

Agents: read `AGENTS.md`, then `docs/architecture.md`, then `docs/status.md`.
