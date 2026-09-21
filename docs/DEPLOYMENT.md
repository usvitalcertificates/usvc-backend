# Backend deployment

Deploy `usvc-backend/` to Render using [render.yaml](../render.yaml). The build command is `npm ci && npm run build`; the start command is `npm run start`.

## Required Render environment variables

| Variable                 | Purpose                                                           |
| ------------------------ | ----------------------------------------------------------------- |
| `MONGODB_URI`            | Atlas connection string.                                          |
| `MONGODB_DB_NAME`        | Database name, for example `usvc`.                                |
| `FRONTEND_URL`           | Exact allowed frontend origin, such as the Vercel production URL. |
| `JWT_ACCESS_SECRET`      | Long, unique signing secret.                                      |
| `JWT_REFRESH_SECRET`     | Different long, unique signing secret.                            |
| `STRIPE_SECRET_KEY`      | Stripe server-side secret key.                                    |
| `STRIPE_WEBHOOK_SECRET`  | Stripe webhook signing secret.                                    |
| `STRIPE_PUBLISHABLE_KEY` | Stripe publishable key returned to checkout initialization.       |

## Before accepting real orders

- Use a paid Atlas cluster with backups and point-in-time recovery appropriate to your business.
- Allow Render’s outbound network access in Atlas and create a least-privilege Atlas database user.
- Set `FRONTEND_URL` to the production HTTPS frontend, never `*`.
- Configure Stripe production webhooks for `https://YOUR-API/webhooks/stripe` and use the matching production webhook secret.
- Keep Stripe test and live keys isolated by environment.
- Verify the `/health` endpoint and one Stripe test webhook before launch.
