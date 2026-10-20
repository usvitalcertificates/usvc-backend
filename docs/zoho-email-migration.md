# Zoho CPaaS email setup: API key + signed webhooks

USVC sends all transactional email through the Zoho CPaaS India HTTPS API. The default setup needs only the Agent send API key and a signed-webhook Authentication Key, plus existing sender/application settings. No Agent key, OAuth client, refresh token, SMTP settings or frontend email credentials are required. Templates, subjects, sender/Reply-To, payment rules and recovery links stay unchanged.

## Backend environment

Add these to `usvc-backend/.env`, or the backend service's environment settings. Use separate Agent credentials and webhook secrets for staging and production. Keep delivery disabled until setup, deployment and queue review are ready.

```dotenv
EMAIL_ENABLED="false"
# Copy the raw API token from Agent > SMTP/API > API Setup (left side).
# Strip the "Zoho-enczapikey " prefix if present.
ZOHO_EMAIL_API_KEY="YOUR_RAW_SEND_API_KEY"
# Generate a random 32+ character secret; set the SAME value as the Agent Authentication Key.
ZOHO_WEBHOOK_SECRET="YOUR_RANDOM_WEBHOOK_AUTHENTICATION_KEY"
EMAIL_FROM="US Vital Certificates <noreply@usvitalcertificates.org>"
EMAIL_REPLY_TO="support@usvitalcertificates.org"
```

Use your existing verified/authorized From address and actual support mailbox. `ZOHO_EMAIL_API_KEY`, `ZOHO_WEBHOOK_SECRET`, `EMAIL_FROM`, `EMAIL_REPLY_TO` and `STAFF_PORTAL_URL` are required when `EMAIL_ENABLED=true`. No real `.env` secrets are edited or committed by this change.

For the simple setup, completely remove/unset `ZOHO_EMAIL_AGENT_KEY`, `ZOHO_OAUTH_CLIENT_ID`, `ZOHO_OAUTH_CLIENT_SECRET` and `ZOHO_OAUTH_REFRESH_TOKEN`; do not leave placeholder or empty values. Also remove obsolete `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER` and `SMTP_PASSWORD`.

### Staging

```dotenv
FRONTEND_URL="https://staging.usvitalcertificates.org"
STAFF_PORTAL_URL="https://staging.usvitalcertificates.org"
EMAIL_RECIPIENT_OVERRIDE="YOUR_CONTROLLED_TEST_INBOX"
```

The override must be a real valid address you control. It overrides every recipient, including staff invitations and internal contact notifications. Use synthetic applications and Stripe test keys. After deployment, webhook setup and queue review, enable delivery with `EMAIL_ENABLED="true"`.

### Production

At a separately authorized cutover, use production credentials and:

```dotenv
FRONTEND_URL="https://usvitalcertificates.org"
STAFF_PORTAL_URL="https://flow.usvitalcertificates.org"
# EMAIL_RECIPIENT_OVERRIDE must be completely UNSET in production.
```

Keep database, encryption, Stripe, JWT, analytics and unrelated settings unchanged.

## Signed webhook configuration

1. Generate a 48-character secret locally with `openssl rand -hex 24` (Zoho limits this field to 50 characters). Put the result in backend `ZOHO_WEBHOOK_SECRET`.
2. In the corresponding Zoho Agent, open **Webhooks → Authentication Key** and enter exactly that same secret. Use an Agent-specific secret; it establishes the callback's identity without requiring an Agent key in USVC.
3. Deploy the new backend code before clicking Verify. Staging URL: **`https://staging-api.usvitalcertificates.org/webhooks/zoho`**. Production URL after authorized production deployment: **`https://api.usvitalcertificates.org/webhooks/zoho`**.
4. Leave the optional Authorization-header inputs blank. The backend validates Zoho's `producer-signature` itself. GET and unsigned POST reachability checks return 200 without exposing records. Unsigned POST bodies are discarded before event parsing or database access and return `{received:false}`. Zoho's Verify sends `Content-Type: application/json` signed over the raw body; documented form-encoded deliveries are signed over the decoded parameter value, and both are accepted. Validly signed Zoho samples or unrelated emails with non-USVC/missing client references are acknowledged without database access. Actual receipt updates require a matching 64-character USVC reference. Actual event processing requires valid HMAC-SHA256 and a valid timestamp; a present invalid signature returns 401.
5. Select **Delivered**, **Soft bounces**, **Hard bounces**, and optionally **Feedback loop**. Leave open/click tracking disabled and other messaging channels unchecked. Click Verify and Add.
6. Complete account/sender approval and Zoho DKIM/return-path DNS setup. Preserve mailbox MX; do not create duplicate SPF records. Keep DMARC aligned with the sender.

The API explicitly sets `track_opens:false` and `track_clicks:false`, including private recovery links and verification codes. Leave tracking disabled in the Agent as well. No SMTP ports or Nodemailer package are used.

## Delivery behavior and limitations

The existing transactional outbox leases jobs and durably reserves a permanent `email_dispatches` receipt before contacting Zoho. Only explicit retryable API rejections requeue. Timeouts, ambiguous responses and crashes cannot cause a blind second send. Receipts retain opaque references, record IDs, timestamps and sanitized states, never recipients, bodies, links, codes or credentials.

- A normal API acceptance finalizes the original outbox/audit transaction once.
- An uncertain send becomes HELD while awaiting a signed webhook. Delivery or bounce establishes prior Zoho acceptance and finalizes the same message; a bounce is a separate delivery outcome, never a reason to resend.
- Without optional log credentials, housekeeping makes **no OAuth or log API calls**. It only manages waiting deadlines and secret cleanup.
- If no webhook arrives, the message remains unresolved. At 24 hours or earlier message-secret expiry it becomes REVIEW/HELD without another send. There is no automatic retry based on a missing callback.
- Valid late callbacks can still resolve permanent receipts after expiry or recovery-job TTL deletion. Expired secrets are never recreated and expired OTPs/links are never made valid again.
- Duplicate and out-of-order callbacks cannot duplicate audits or downgrade terminal delivery outcomes. Unknown events or dispatch references cannot create jobs or finalize unrelated messages. HMAC authentication is required before callback processing.
- If an optional Agent key is configured, callbacks must match it; otherwise the Agent-specific signing secret plus the existing opaque dispatch reference authorize receipt matching.
- Provider acceptance or delivery to the recipient mail server is not a guarantee of inbox placement. No exactly-once provider guarantee is claimed.

Verification codes retain 10-minute expiry, five attempts and 60-second resend cooldown; recovery links retain 48-hour expiry and sessions 30 minutes. No historical emails are replayed.

## Optional future log lookup fallback

No OAuth setup is necessary for the default configuration above. If desired later, add **all four** server-only values:

```dotenv
ZOHO_EMAIL_AGENT_KEY="YOUR_ACTUAL_AGENT_KEY"
ZOHO_OAUTH_CLIENT_ID="YOUR_INDIA_CLIENT_ID"
ZOHO_OAUTH_CLIENT_SECRET="YOUR_CLIENT_SECRET"
ZOHO_OAUTH_REFRESH_TOKEN="YOUR_REFRESH_TOKEN"
```

Use India-region OAuth with `Zeptomail.email.READ`. Log checking activates only when all four are present; partial configuration makes no log requests. An explicitly configured Agent key still restricts callback ownership, so do not put the Agent Alias or a placeholder here. Access tokens refresh automatically and are never an environment setting. Reads go to `https://cpaas.zoho.in/v1.1/email`; OAuth refresh goes to `https://accounts.zoho.in/oauth/v2/token`. Missing/failed log results never authorize a resend.

Build before running operations commands. `EMAIL_ENABLED=false npm run email:report` reports non-content receipt/legacy references without sending email. `EMAIL_ENABLED=false npm run email:reconcile -- 'OUTBOX_RECORD_ID'` needs the optional four log credentials and performs evidence lookup only; it cannot release a hold for resending.

## Frontend environment

No changes. Keep `API_URL` pointed at the corresponding backend. Never put mail credentials in the frontend or `NEXT_PUBLIC_*` variables.

## Staging checks and Resend removal

1. Pause delivery and drain old workers before switching providers. Do not run Resend and Zoho workers against the same queue.
2. Review old attempted jobs. Previously attempted jobs without Zoho evidence remain LEGACY/REVIEW; this release has no Resend client or fallback. Resolve against the old provider's dashboard or keep held; never bulk-reset status/attempts.
3. Configure the staging API key, signing secret, sender, recipient override and callback. Enable delivery only when ready to send eligible queued jobs.
4. Test synthetic confirmation, failure → delayed recovery, resume → OTP → saved application, submission updates, customer contact receipts, internal support Reply-To and staff invitations. Check delivery/bounce callbacks, duplicate callbacks, missing callbacks and unchanged templates/links.
5. Check controlled Gmail/Outlook/Yahoo inboxes, reply routing, sender alignment and absence of tracking redirects. Local mocked tests do not verify real inbox delivery.
6. After staging passes, remove staging `RESEND_API_KEY`. Keep production's old release/key until a separately authorized production cutover.
7. At production cutover, repeat pause/drain, queue review, sender and callback checks; remove the staging recipient override. Remove/revoke production's Resend key only after Zoho verification and resolution of outstanding Resend dispatches.
8. For rollback, pause Zoho workers and review DISPATCHING/UNCERTAIN/REVIEW receipts before enabling old workers. Never blindly replay held jobs.

No Blueprint sync, deployment, DNS edits, real emails or production changes are performed by these code edits. Render placeholders now request only the required API key and webhook secret for Zoho; optional OAuth values can be added separately later.

Official references: [API authentication](https://www.zoho.com/cpaas/help/api/api-authentication.html), [send API](https://www.zoho.com/cpaas/help/api/email-sending.html), [signed webhooks](https://www.zoho.com/cpaas/help/webhooks.html), [optional read-only email logs](https://www.zoho.com/cpaas/help/api/get-email-logs.html).
