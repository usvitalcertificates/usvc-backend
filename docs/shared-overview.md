# Shared project overview

## What USVC is

US Vital Certificates: public site for ordering vital certificates (birth, death, marriage, divorce) + internal fulfillment portal for staff to claim and process paid orders.

## The two repos

- This repo (`usvc-backend`): Express 5 + TypeScript + Mongoose on MongoDB Atlas. Deployed to Render (`usvc-api`, Node 24). Listens on `:4000` locally.
- `usvc-frontend/` (sibling repo): Next.js 16 App Router, React 19, Node 24. Deployed to Vercel. One project serves both hosts.
- AI docs live in each repo's `docs/` in the same structure (`architecture.md`, `coding-rules.md`, `shared-*.md` are mirrored in both; `public-api.md` / `staff-api.md` here vs `main-website.md` / `flow-portal.md` there). Keep shared facts in `shared-*.md`; do not duplicate them into per-topic files.

## Hosts and environments

| Env     | Public site                          | Staff portal (`flow`)                    | Backend                 |
| ------- | ------------------------------------ | ---------------------------------------- | ----------------------- |
| Local   | `http://localhost:3000` (all paths)  | `http://localhost:3000/auth`, `/staff/*` | `http://localhost:4000` |
| Preview | `*.vercel.app` (all paths)           | same, by path                            | test API + test Stripe  |
| Staging | `staging.usvitalcertificates.org`    | same host, by path                       | staging Render          |
| Prod    | apex + `www.usvitalcertificates.org` | `flow.usvitalcertificates.org`           | prod Render             |

Single frontend project with host-split `middleware.ts`: `flow.*` serves only `/auth` + `/staff/*` (root `/` rewrites to queue); public host 404s `/auth`, `/staff/*`. Previews/localhost/staging allow all paths.

## Git workflow (locked, both code repos)

- `main` = production. `develop` = staging. Never commit directly to either.
- Feature branch from `develop`: `git checkout -b feat/<name> develop`, PR against `develop`.
- Merge `develop` → `main` only for production releases.

## Quality gates

- Frontend: `npm run format`, `npm run format:check`, `npm run lint`, `npm run build` (pre-commit: lint-staged + `tsc --noEmit`).
- Backend: `npm run format`, `npm run format:check`, `npm run lint`, `npm run build`, `npm test` (pre-commit: lint-staged + `tsc --noEmit` + `npm test`).
- ESLint covers JS/MJS configs; TS gate is `tsc` (typescript-eslint blocked on TS 7). Prettier owns style.

## Freshness rule

After any code change, update the matching files in `docs/` in the same turn (see `AGENTS.md`).
