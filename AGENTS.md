# Backend contribution rules

This folder is the USVC Express + TypeScript API. It uses MongoDB Atlas through Mongoose; raw driver code, Mongoose alternatives, Prisma, PostgreSQL, and plaintext secret storage are not part of this project.

## Read order for AI agents

1. `docs/shared-overview.md`, `docs/shared-glossary.md`, `docs/shared-security.md`.
2. This file, then `docs/architecture.md`, then `docs/coding-rules.md`.
3. Task-specific: customer-facing order/payment/tracking → `docs/public-api.md`; invite/auth/queue/reveal/admin → `docs/staff-api.md`; deploys/env → `docs/workflows.md`; fulfillment plan → `docs/fulfillment.md`; status/backlog → `docs/status.md`.

## Public API vs Staff API

- **Public API** (`docs/public-api.md`): no token — order create/verify/geo/checkout/tracking/contact + Stripe webhooks (signature, not JWT).
- **Staff API** (`docs/staff-api.md`): `requireAuth` + assigned-or-admin or `requireAdmin`. Queue claim, detail, notes, correction, status, documents, reveal/audit, admin roster/analytics.
- Keep public projections whitelisted (never sensitive order fields); staff reads go through authorized endpoints only.

## Hard rules (full list in `docs/coding-rules.md`)

- Money as integer cents, calculated only on the server. Never trust browser totals.
- Validate every request with Zod before use.
- Mongoose typed models + startup indexes. No manual production data changes.
- Stripe webhooks: signature verify + event-ID idempotency + transaction-safe updates.
- Never log/return plaintext customer PII or secrets. Sensitive order fields are never in public projections; staff reads go only through authorized, audited endpoints.
- Gates before handoff: `npm run build` + `npm test`, plus `format`, `format:check`, `lint`. Pre-commit: lint-staged + `tsc --noEmit` + `npm test`.

## Git workflow (locked)

- `main` = production. `develop` = staging. Never commit directly to either.
- Always create a feature branch from `develop` (`git checkout -b feat/<name> develop`) and raise the PR against `develop`.
- Merge `develop` → `main` only for production releases.
- After any code change, update `docs/status.md` + the matching `docs/` topic file in the same turn.
