# Backend contribution rules

USVC Express + TypeScript API. MongoDB Atlas through Mongoose; raw driver code, Mongoose alternatives, Prisma, PostgreSQL, and plaintext secret storage are not part of this project.

Read: `docs/architecture.md`, then `docs/status.md`.

Hard rules:

- Money as integer cents, calculated only on the server. Never trust browser totals.
- Validate every request with Zod before use.
- Mongoose typed models + startup indexes. No manual production data changes. Prefer atomic `$push`/`$set` updates for projection-loaded docs.
- Stripe webhooks: signature verify + event-ID idempotency + transaction-safe updates. Browser redirect never trusted.
- Never log/return plaintext customer PII or secrets. Internal order fields are never in public projections; staff reads go only through authorized, audited endpoints. Outbox deliveries (email/GA4/OpenAI) are leased + idempotent.
- Fresh `SENSITIVE_ENCRYPTION_KEY` per environment; losing the prod key is unrecoverable.

Gates: `npm run build` + `npm test`, plus `format`, `format:check`, `lint`. Pre-commit: lint-staged + `tsc --noEmit` + `npm test`.

Git: `main` = production, `develop` = staging. Never commit to either. `feat/<name>` from `develop` → PR to `develop`. `develop` → `main` only for releases.

After any code change, update `docs/status.md` in the same turn.
