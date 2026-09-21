# Backend contribution rules

This folder is the USVC Express + TypeScript API. It uses MongoDB Atlas through Mongoose; raw driver code, Mongoose alternatives, Prisma, PostgreSQL, and raw payment-card storage are not part of this project.

- Keep money as integer cents and calculate totals only on the server.
- Validate every request with Zod before using it.
- Use typed MongoDB collections and startup indexes. Do not make manual production data changes.
- Stripe webhooks must have signature verification, event idempotency, and transaction-safe order updates.
- Never accept, log, store, or return PAN, CVV, expiry data, Stripe secret keys, JWT secrets, or other credentials.
- Requestor SSN and payment-card fields are stored as plaintext on the order document per owner requirement (government formalities + admin access). They must never be returned by public tracking/confirmation projections and never logged. Staff reads require explicit authorization (Phase 2).
- Do not place real values in `.env.example` or documentation.
- Keep public application data separate from staff-only information.
- Run `npm run build` and `npm test` before handoff.
- Format with `npm run format`, verify with `npm run format:check` and `npm run lint`.
- A pre-commit hook runs lint-staged, then `tsc --noEmit`, then `npm test`. Hooks install via `npm install` (`prepare` script).
- ESLint covers JS configs/scripts; TS rules are blocked on typescript-eslint supporting TypeScript 7, so `tsc` is the TS gate and Prettier owns style.

See [README.md](README.md) and [docs/CURRENT_STATUS.md](docs/CURRENT_STATUS.md) before adding a module.

- Plan and track work in [docs/TODO.md](docs/TODO.md); log locked choices in [docs/DECISIONS.md](docs/DECISIONS.md). After any code change, update `docs/TODO.md` + `docs/CURRENT_STATUS.md` in the same turn.

## Git workflow (locked)

- `main` = production. `develop` = staging. Never commit directly to either.
- Always create a feature branch from `develop` (`git checkout -b feat/<name> develop`) and raise the PR against `develop`.
- Merge `develop` → `main` only for production releases.
