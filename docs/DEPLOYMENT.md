# Backend deployment

Deploy `usvc-backend/` to Render using [render.yaml](../render.yaml). The build command is `npm ci && npm run build`; the start command is `npm run start`.

## Required Render environment variables

| Variable                              | Purpose                                                                                                                                                                                                                                                   |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MONGODB_URI`                         | Atlas connection string.                                                                                                                                                                                                                                  |
| `MONGODB_DB_NAME`                     | Database name, for example `usvc`.                                                                                                                                                                                                                        |
| `FRONTEND_URL`                        | Exact allowed frontend origin, such as the Vercel production URL.                                                                                                                                                                                         |
| `JWT_ACCESS_SECRET`                   | Long, unique signing secret.                                                                                                                                                                                                                              |
| `JWT_REFRESH_SECRET`                  | Different long, unique signing secret.                                                                                                                                                                                                                    |
| `STRIPE_SECRET_KEY`                   | Stripe server-side secret key.                                                                                                                                                                                                                            |
| `STRIPE_WEBHOOK_SECRET`               | Stripe webhook signing secret.                                                                                                                                                                                                                            |
| `STRIPE_PUBLISHABLE_KEY`              | Stripe publishable key returned to checkout initialization.                                                                                                                                                                                               |
| `EMAIL_ENABLED`                       | Set to `true` only after Resend and the sender domain are ready.                                                                                                                                                                                          |
| `RESEND_API_KEY`                      | Resend sending API key; never commit this value.                                                                                                                                                                                                          |
| `EMAIL_FROM`                          | `US Vital Certificates <noreply@usvitalcertificates.org>`.                                                                                                                                                                                                |
| `EMAIL_REPLY_TO`                      | Customer-support reply address.                                                                                                                                                                                                                           |
| `EMAIL_RECIPIENT_OVERRIDE`            | Staging-only inbox that receives every test confirmation.                                                                                                                                                                                                 |
| `STAFF_PORTAL_URL`                    | Origin of the staff portal for invitation setup links (`https://flow.usvitalcertificates.org` in production, staging URL in staging). Required when `EMAIL_ENABLED=true`.                                                                                 |
| `ANALYTICS_ENABLED`                   | Set `true` only in production; leave `false` in staging.                                                                                                                                                                                                  |
| `GA_MEASUREMENT_ID`                   | Production GA4 web stream ID: `G-GM4PWPHER1`.                                                                                                                                                                                                             |
| `GA4_MEASUREMENT_PROTOCOL_API_SECRET` | GA4 Measurement Protocol secret; never commit this value.                                                                                                                                                                                                 |
| `SENSITIVE_ENCRYPTION_KEY`            | 64-char hex (or base64) 32-byte key for `confidentialData` AES-256-GCM; set as a Render secret (`sync: false`). Generate one per environment; never reuse the local dev key. Losing the production key makes stored SSN/card data permanently unreadable. |
| `SENSITIVE_KEY_ID`                    | Key id, currently `v1`; must match the `keyId` stored in `confidentialData`.                                                                                                                                                                              |

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

## Staff portal staging check

1. In the Render staging service, set `STAFF_PORTAL_URL` to the staging frontend origin (e.g. `https://staging.usvitalcertificates.org`) alongside the existing email settings.
2. Invite a test address from `/staff/admin`; with `EMAIL_RECIPIENT_OVERRIDE` set, the invitation lands in the internal inbox. Click the setup link, set a password, pair an authenticator, and confirm the queue loads.
3. Existing staging orders are kept; the queue lists paid orders only, so complete at least one Stripe test payment (or mark a test order paid) to exercise claim → status → close.

## GA4 purchase tracking

1. In Google Analytics, open **Admin → Data streams**, select `G-GM4PWPHER1`, then open **Measurement Protocol API secrets**.
2. Create a secret named `USVC Production Backend`, copy it once, and add it to the production Render service as `GA4_MEASUREMENT_PROTOCOL_API_SECRET`.
3. Set `ANALYTICS_ENABLED=true` and `GA_MEASUREMENT_ID=G-GM4PWPHER1` in production Render. In Vercel production, set the same first two values. Set `ANALYTICS_ENABLED=false` in both staging services.
4. Mark GA4's `purchase` event as a key event. If Google Ads imports that GA4 conversion, do not also create a direct Google Ads purchase conversion.

## GA4 state breakdown (custom dimensions)

Funnel events (`select_state`, `select_certificate`, `order_started`, `begin_checkout`, `add_payment_info`) and the server `purchase` all carry `state_code` (`CA`, `NY`, …) plus `certificate`. They appear in standard reports only after registering both as event-scoped custom dimensions:

1. In Google Analytics, open **Admin → Data display → Custom definitions**.
2. Create a custom dimension: Dimension name `State`, Scope `Event`, Event parameter `state_code`.
3. Create a custom dimension: Dimension name `Certificate`, Scope `Event`, Event parameter `certificate`.
4. Build the state funnel in **Explore** (e.g. filter `state_code` = `CA`, break down by event name). Allow 24–48 hours for dimensions to populate; data accumulates from deploy time even before registration, but standard reports only show it afterwards. Skipping registration breaks nothing — params are still collected for future use.

The browser records public page and funnel activity only. A signed Stripe paid webhook atomically queues one server-side GA4 Purchase delivery in `analytics_purchase_deliveries`; the worker leases and retries it and uses the public order number as the transaction ID. No names, email addresses, phone numbers, addresses, dates of birth, SSNs, certificate subject details, card data, or Stripe identifiers are sent to GA4.

## Email images and inbox avatar

Transactional emails deliberately contain no remote images: Gmail and other
providers proxy (and sometimes break) externally hosted images, so templates
render text-only headers with the USVC name. This is enforced by tests
(`assert.doesNotMatch(html, /<img/)` on every template). To show a logo
beside the sender in supported inboxes, publish SPF/DKIM and a DMARC policy of `p=quarantine` or `p=reject` at 100%, then configure BIMI with a hosted compatible SVG and a Common Mark Certificate or Verified Mark Certificate for Gmail support. Also register the business and upload the square PNG through Apple Business Connect for Apple Branded Mail. Inbox clients control whether an avatar is shown; Outlook does not reliably support this branding path.
