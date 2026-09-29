# Backend workflows (dev, build, deploy)

## Local dev

```bash
cp .env.example .env   # Atlas mongodb+srv://, Stripe TEST keys, webhook secret from CLI
npm install
npm run dev            # auto-reload; use this, not npm start (stale dist/ unless rebuilt)
npm run build && npm test
```

Health: `GET http://localhost:4000/health`. Startup connects to Mongo + creates indexes. `_id index` bootstrap error → don't create explicit `_id` index (Mongo does it).

Staff local test: seed ADMIN in `staff_users` (Argon2 hash — generate via `npx tsx -e`, never plaintext; `role: ADMIN`, `active`); frontend `API_URL=http://localhost:4000`; pair TOTP at `/auth`; invite agent (incognito); submit public applications then flip to `PAID/PAID` in Mongo (email-disabled envs return `setupToken`).

## Env vars (names only — never commit values)

`MONGODB_URI`, `MONGODB_DB_NAME`, `FRONTEND_URL` (exact origin), `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY`, `EMAIL_ENABLED`, `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `EMAIL_RECIPIENT_OVERRIDE` (staging-only), `STAFF_PORTAL_URL` (required when email on; prod `https://flow.usvitalcertificates.org`), `SENSITIVE_ENCRYPTION_KEY` (secret, fresh per env), `SENSITIVE_KEY_ID` (`v1`), `ANALYTICS_ENABLED`, `GA_MEASUREMENT_ID`, `GA4_MEASUREMENT_PROTOCOL_API_SECRET`, `OPENAI_CONVERSIONS_ENABLED`, `OPENAI_ADS_PIXEL_ID`, `OPENAI_CONVERSION_SOURCE_URL`, `OPENAI_CONVERSIONS_API_KEY`. Plus optional `NODE_ENV` (default `development`) and `PORT` (default `4000`), accepted by `config/env.ts` but absent from `.env.example`.

`render.yaml` sets only 12 keys (`NODE_VERSION`, `EMAIL_*` non-secret, `RESEND_API_KEY`, `ANALYTICS_*`, `OPENAI_*`, `SENSITIVE_*` — secrets as `sync: false`). These must be set on the Render dashboard instead: `MONGODB_URI`, `MONGODB_DB_NAME`, `FRONTEND_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY`, `STAFF_PORTAL_URL`, `EMAIL_RECIPIENT_OVERRIDE` (staging only).

## Render deploy

Service `usvc-api`, `rootDir: usvc-backend`, build `npm ci && npm run build`, start `npm run start`, `/health` check, Node 24. Required vars per table above. Before real orders: paid Atlas + backups, least-privilege user + IP allow, exact `FRONTEND_URL`, prod webhook + secret, key isolation, `/health` + test webhook check. Test/staging keys never in prod.

Resend: verify domain (SPF/DKIM), separate staging/prod keys, staging `EMAIL_RECIPIENT_OVERRIDE`, Workbench events (`payment_intent.succeeded/failed`, `checkout.session.completed/async_payment_succeeded/async_payment_failed`). Outbox (`email_outbox`) leases/retries; inspect failures there. GA4: `ANALYTICS_ENABLED=true` + Measurement Protocol secret in prod only; register `state_code` + `certificate` custom dimensions; browser never sends `purchase`.

## Gates

`npm run format` → `npm run format:check` → `npm run lint` → `npm run build` → `npm test`. Pre-commit: lint-staged + `tsc --noEmit` + `npm test`.
