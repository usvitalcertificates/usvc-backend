# Backend deployment

Deploy `usvc-backend/` to Render using [render.yaml](../render.yaml). The build command is `npm ci && npm run build`; the start command is `npm run start`.

## Required Render environment variables

| Variable                   | Purpose                                                           |
| -------------------------- | ----------------------------------------------------------------- |
| `MONGODB_URI`              | Atlas connection string.                                          |
| `MONGODB_DB_NAME`          | Database name, for example `usvc`.                                |
| `FRONTEND_URL`             | Exact allowed frontend origin, such as the Vercel production URL. |
| `JWT_ACCESS_SECRET`        | Long, unique signing secret.                                      |
| `JWT_REFRESH_SECRET`       | Different long, unique signing secret.                            |
| `STRIPE_SECRET_KEY`        | Stripe server-side secret key.                                    |
| `STRIPE_WEBHOOK_SECRET`    | Stripe webhook signing secret.                                    |
| `STRIPE_PUBLISHABLE_KEY`   | Stripe publishable key returned to checkout initialization.       |
| `EMAIL_ENABLED`            | Set to `true` only after Resend and the sender domain are ready.  |
| `RESEND_API_KEY`           | Resend sending API key; never commit this value.                  |
| `EMAIL_FROM`               | `US Vital Certificates <noreply@usvitalcertificates.org>`.        |
| `EMAIL_REPLY_TO`           | Customer-support reply address.                                   |
| `EMAIL_RECIPIENT_OVERRIDE` | Staging-only inbox that receives every test confirmation.         |

## Before accepting real orders

- Use a paid Atlas cluster with backups and point-in-time recovery appropriate to your business.
- Allow Render’s outbound network access in Atlas and create a least-privilege Atlas database user.
- Set `FRONTEND_URL` to the production HTTPS frontend, never `*`.
- Configure Stripe production webhooks for `https://YOUR-API/webhooks/stripe` and use the matching production webhook secret.
- Keep Stripe test and live keys isolated by environment.
- Verify the `/health` endpoint and one Stripe test webhook before launch.

## Payment-confirmation email setup

1. In Resend, open **Domains**, add `usvitalcertificates.org`, and publish every SPF and DKIM record shown in the dashboard. Wait until sending is verified.
2. In Resend, create separate staging and production API keys.
3. In the Render staging service, set `EMAIL_ENABLED=true`, the staging `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, and an internal `EMAIL_RECIPIENT_OVERRIDE`. Choose **Save, rebuild, and deploy**.
4. In Stripe sandbox **Workbench → Webhooks**, add a webhook destination for `https://usvc-backend.onrender.com/webhooks/stripe`. Select `payment_intent.succeeded`, `payment_intent.payment_failed`, `checkout.session.completed`, `checkout.session.async_payment_succeeded`, and `checkout.session.async_payment_failed`.
5. Copy that destination's `whsec_...` value to the staging Render `STRIPE_WEBHOOK_SECRET`, then redeploy and complete a test payment. Confirm exactly one message appears in Resend Logs and the internal override inbox.
6. For production, repeat the Stripe destination in live mode and use a production Resend key. Do not define `EMAIL_RECIPIENT_OVERRIDE` in production.

Confirmation emails are created only by signed Stripe success events. A MongoDB outbox retries temporary delivery failures without changing payment state. Failed jobs can be inspected in the `email_outbox` collection without exposing application or payment-card details.
