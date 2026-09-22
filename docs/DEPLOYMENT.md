# Backend deployment

Deploy `usvc-backend/` to Render using [render.yaml](../render.yaml). The build command is `npm ci && npm run build`; the start command is `npm run start`.

## Required Render environment variables

| Variable                              | Purpose                                                           |
| ------------------------------------- | ----------------------------------------------------------------- |
| `MONGODB_URI`                         | Atlas connection string.                                          |
| `MONGODB_DB_NAME`                     | Database name, for example `usvc`.                                |
| `FRONTEND_URL`                        | Exact allowed frontend origin, such as the Vercel production URL. |
| `JWT_ACCESS_SECRET`                   | Long, unique signing secret.                                      |
| `JWT_REFRESH_SECRET`                  | Different long, unique signing secret.                            |
| `STRIPE_SECRET_KEY`                   | Stripe server-side secret key.                                    |
| `STRIPE_WEBHOOK_SECRET`               | Stripe webhook signing secret.                                    |
| `STRIPE_PUBLISHABLE_KEY`              | Stripe publishable key returned to checkout initialization.       |
| `EMAIL_ENABLED`                       | Set to `true` only after Resend and the sender domain are ready.  |
| `RESEND_API_KEY`                      | Resend sending API key; never commit this value.                  |
| `EMAIL_FROM`                          | `US Vital Certificates <noreply@usvitalcertificates.org>`.        |
| `EMAIL_REPLY_TO`                      | Customer-support reply address.                                   |
| `EMAIL_RECIPIENT_OVERRIDE`            | Staging-only inbox that receives every test confirmation.         |
| `ANALYTICS_ENABLED`                   | Set `true` only in production; leave `false` in staging.          |
| `GA_MEASUREMENT_ID`                   | Production GA4 web stream ID: `G-GM4PWPHER1`.                     |
| `GA4_MEASUREMENT_PROTOCOL_API_SECRET` | GA4 Measurement Protocol secret; never commit this value.         |

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

## GA4 purchase tracking

1. In Google Analytics, open **Admin → Data streams**, select `G-GM4PWPHER1`, then open **Measurement Protocol API secrets**.
2. Create a secret named `USVC Production Backend`, copy it once, and add it to the production Render service as `GA4_MEASUREMENT_PROTOCOL_API_SECRET`.
3. Set `ANALYTICS_ENABLED=true` and `GA_MEASUREMENT_ID=G-GM4PWPHER1` in production Render. In Vercel production, set the same first two values. Set `ANALYTICS_ENABLED=false` in both staging services.
4. Mark GA4's `purchase` event as a key event. If Google Ads imports that GA4 conversion, do not also create a direct Google Ads purchase conversion.

The browser records public page and funnel activity only. A signed Stripe paid webhook atomically queues one server-side GA4 Purchase delivery in `analytics_purchase_deliveries`; the worker leases and retries it and uses the public order number as the transaction ID. No names, email addresses, phone numbers, addresses, dates of birth, SSNs, certificate subject details, card data, or Stripe identifiers are sent to GA4.

## Email logo and inbox avatar

Every HTML email loads the public logo from `https://www.usvitalcertificates.org/assets/usvc-logo.png`; no additional application environment variable is required. To show the logo beside the sender in supported inboxes, publish SPF/DKIM and a DMARC policy of `p=quarantine` or `p=reject` at 100%, then configure BIMI with a hosted compatible SVG and a Common Mark Certificate or Verified Mark Certificate for Gmail support. Also register the business and upload the square PNG through Apple Business Connect for Apple Branded Mail. Inbox clients control whether an avatar is shown; Outlook does not reliably support this branding path.
