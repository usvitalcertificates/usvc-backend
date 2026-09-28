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

All AI documentation lives in the sibling private repo `../usvc-ai-context/` — see `usvc-backend/AGENTS.md` there.
