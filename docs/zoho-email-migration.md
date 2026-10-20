# Zoho CPaaS email migration

USVC sends all transactional emails through Zoho CPaaS India using encrypted SMTP. Signed Zoho webhooks and a read-only HTTPS log API resolve uncertain sends automatically. The frontend never sends email directly. Existing subjects, templates, Reply-To behavior, recovery links, pricing and payment rules stay unchanged.

## Backend environment (`usvc-backend/.env` or Render API service)

Add these **server-only** values. Use a separate Agent and credentials for staging and production. Do not commit secrets or paste them into chat.

```dotenv
# Enable only after account/domain approval and configuration below.
EMAIL_ENABLED="true"
# SMTP Credentials panel (right side of the screenshot).
SMTP_HOST="smtp.zeptomail.in"
SMTP_PORT="465"
SMTP_USER="emailapikey"
SMTP_PASSWORD="YOUR_SMTP_PASSWORD_1"
# Random 32+ character secret; configure the SAME value as the Agent Authentication Key.
ZOHO_WEBHOOK_SECRET="YOUR_RANDOM_WEBHOOK_AUTHENTICATION_KEY"
# Actual Agent key from Zoho; do not assume the display name/Agent Alias is the key.
ZOHO_EMAIL_AGENT_KEY="YOUR_AGENT_KEY"
ZOHO_OAUTH_CLIENT_ID="YOUR_INDIA_OAUTH_CLIENT_ID"
ZOHO_OAUTH_CLIENT_SECRET="YOUR_OAUTH_CLIENT_SECRET"
ZOHO_OAUTH_REFRESH_TOKEN="YOUR_OFFLINE_REFRESH_TOKEN"

# Keep your existing approved sender and support mailbox.
EMAIL_FROM="US Vital Certificates <noreply@usvitalcertificates.org>"
EMAIL_REPLY_TO="support@usvitalcertificates.org"
```

SMTP password, webhook secret, the four Agent/OAuth values, sender, Reply-To and `STAFF_PORTAL_URL` are required when email is enabled. SMTP host/port/username default to the values above. Keys are not required with `EMAIL_ENABLED="false"`; recovery remains unavailable in that mode. Do not put placeholders in an enabled deployed service.

Sending uses only `smtp.zeptomail.in`: port 465 with implicit TLS, or port 587 with mandatory STARTTLS. Certificate validation stays enabled. Copy **Password 1** from Agent → SMTP/API → SMTP Credentials; do not use your Zoho account password or the API key on the left. The API send token (`ZOHO_EMAIL_API_KEY`) is no longer used and can be removed.

The read-only fallback fixes the region to `https://cpaas.zoho.in/v1.1/email`; OAuth refresh uses `https://accounts.zoho.in/oauth/v2/token`. It never sends email. Use India-region credentials with only `Zeptomail.email.READ`. The Agent Alias on the screenshot is not necessarily the actual Agent key; use the key from Zoho's Agent details/log API configuration.

**Hosting:** SMTP requires outbound TCP 465 or 587. Render's Free service instances block both ports; use a paid API service instance for SMTP. This change does not upgrade or deploy services. [Render port restrictions](https://render.com/docs/free#other-limitations)

### Staging values

```dotenv
FRONTEND_URL="https://staging.usvitalcertificates.org"
STAFF_PORTAL_URL="https://staging.usvitalcertificates.org"
# Use a real controlled inbox that you own. This overrides ALL email recipients,
# including staff invitations and internal contact notifications.
EMAIL_RECIPIENT_OVERRIDE="YOUR_CONTROLLED_TEST_INBOX"
```

The override must be a valid email address. Confirm the displayed sender domain is verified in the staging Agent. Use test Stripe keys and synthetic applications. Keep `EMAIL_ENABLED="false"` until the staging deployment and queue review are ready; enabling it starts delivery of eligible queued jobs.

### Production values (only at a separately authorized cutover)

```dotenv
FRONTEND_URL="https://usvitalcertificates.org"
STAFF_PORTAL_URL="https://flow.usvitalcertificates.org"
# EMAIL_RECIPIENT_OVERRIDE must be completely UNSET in production.
```

Keep unrelated database, encryption, Stripe, JWT, analytics and other settings unchanged.

## Frontend environment (`usvc-frontend/.env` or Vercel)

**No Zoho or Resend credentials belong here. No frontend environment change is required.** Keep `API_URL` pointed at that environment's backend and retain the current analytics settings. Never add mail keys under `NEXT_PUBLIC_*`. If a mail-provider secret was previously placed in frontend configuration, remove it and rotate it if exposed in a client build; no such frontend variable is required by this repository.

## Zoho setup

1. Complete Zoho transactional-email account approval and sending-domain verification for `usvitalcertificates.org`. Confirm the actual From mailbox is authorized; a domain/Agent entry alone is not proof of approval.
2. Add Zoho-provided DKIM and return-path/authentication DNS records exactly as supplied. Keep mailbox MX records. Do not create a second SPF record; reconcile any required SPF change with the existing record. Keep DMARC aligned with the sender.
3. Copy the SMTP username (`emailapikey`) and generated **Password 1** from the right-hand SMTP Credentials panel. Store the password as `SMTP_PASSWORD`. Use the actual Agent key for `ZOHO_EMAIL_AGENT_KEY`; no send API key is required.
4. In Zoho's **India** API Console (`https://api-console.zoho.in/`), create a server-side/self-client appropriate for your account. Authorize **`Zeptomail.email.READ`** with offline access and exchange the authorization code using Zoho's documented flow to obtain a refresh token. Store the client ID/secret and refresh token in the backend secret store. SMTP credentials alone cannot read logs.
5. Confirm the OAuth user can read the same Agent. Authorization codes are temporary; they are not refresh tokens. Access tokens are refreshed/cached in server memory and are not a separate `.env` value. Never log token responses.
6. Under Agent → Webhooks configure the HTTPS backend URL **`https://YOUR_BACKEND_HOST/webhooks/zoho`** (the API host, not the frontend). Enable **Delivered, Soft bounce and Hard bounce**; feedback-loop events are also supported. Set the Agent **Authentication Key** to exactly `ZOHO_WEBHOOK_SECRET`. Reachability GET returns 200; POST requires a valid `producer-signature`. Zoho posts a single form-encoded event parameter; the backend validates HMAC-SHA256 over the decoded payload, checks its timestamp and Agent, and accepts only known opaque dispatch references. It never stores the event's contacts, subjects or diagnostic contents. Use different secrets/Agents per environment.
7. Explicitly disable open/click tracking in the Agent, including SMTP tracking. SMTP has no per-send HTTP tracking flags. Keep private fragment links free of tracking redirects. Only delivery/bounce events are needed; opens/clicks are ignored.
8. Check the regional credit price, balance and six-month credit expiry. Enable provider low-credit notifications and purchase only the amount needed; no dedicated IP or other channels are required.

Official references: [SMTP configuration](https://www.zoho.com/cpaas/help/smtp-home.html), [signed webhooks](https://www.zoho.com/cpaas/help/webhooks.html), [authentication](https://www.zoho.com/cpaas/help/api/api-authentication.html), [email logs and read scope](https://www.zoho.com/cpaas/help/api/get-email-logs.html).

## Delivery guarantees and monitoring

The transactional outbox still commits jobs with the application event. `email_dispatches` holds permanent, non-content transport evidence separately from expiring recovery jobs. It stores opaque references, record IDs, timestamps and sanitized states; it contains no recipients, HTML, codes, tokens or provider credentials.

- `READY`: no unresolved send; a fenced worker may dispatch.
- `DISPATCHING`: a durable reservation exists. A crash cannot cause another send.
- `UNCERTAIN`: a timeout, ambiguous response or interrupted dispatch requires evidence from Zoho logs.
- `ACCEPTED`: Zoho accepted the email, either through the send response or matching logs. Outbox `SENT` and existing audit names mean accepted for delivery, **not confirmed inbox delivery**.
- `FAILED` / `SKIPPED`: terminal rejection or ineligibility; no automatic replay.
- `REVIEW`: unresolved beyond 24 hours or earlier secret expiry, or a previously attempted legacy job. Operator investigation is required.

An explicit SMTP 4xx rejection uses the existing bounded retry backoff; explicit 5xx authentication/recipient/content rejections stop. Connection loss or a missing final DATA reply never blindly resends. A stable opaque `X-TM-CLIENT-REF` connects SMTP sends to webhooks and log lookup. The stable Message-ID is for correlation, not a provider deduplication guarantee. Signed delivery/bounce events finalize acceptance and retain a separate delivery outcome; duplicate/out-of-order callbacks do not duplicate audits or downgrade terminal outcomes. The first ordinary uncertain-send lookup is after one minute; crashed reservations become eligible after the two-minute sending lease. Reconciliation increases to hourly checks and stops at 24 hours or earlier message expiry. A missing/failed log lookup never proves that another send is safe. A bounce is also evidence of a prior accepted message, not permission to send again.

No exactly-once provider guarantee is claimed. This implementation prioritizes avoiding duplicate emails; messages without conclusive evidence may require manual follow-up. Expired secrets are removed without deleting dispatch evidence. Recovery codes still expire in 10 minutes, links in 48 hours, and the existing resend/verification limits remain intact.

### Operations commands

Build first (`npm run build`). These commands do not start the outbox worker or send email. Prefer `EMAIL_ENABLED=false` for operations-only invocations; log reconciliation still needs its four OAuth/Agent values.

```sh
EMAIL_ENABLED=false npm run email:report
EMAIL_ENABLED=false npm run email:reconcile -- 'OUTBOX_RECORD_ID'
```

`email:report` reports counts plus up to 100 unresolved/legacy record references. It intentionally omits contact values and message contents. Treat nonzero `REVIEW` counts as requiring attention. `email:reconcile` reads Zoho evidence for that one recorded reference; if acceptance is found it finalizes the original delivery/audit transaction. It never releases a hold for resending, never handles Resend through Zoho, and never prints provider contents or credentials. If no evidence is available, the hold remains. Use existing explicit customer code requests/staff invitation flows only after reviewing the original attempt; do not reset dispatch rows or reconstruct messages from deleted secrets.

Use Zoho's dashboard for actual delivery/bounce status and credit monitoring. Provider API acceptance cannot certify Gmail/Outlook/Yahoo inbox placement.

## Staging validation and Resend removal

1. Keep the old production service and its `RESEND_API_KEY` unchanged while staging is tested.
2. Add the SMTP password, webhook secret and four read-only Agent/OAuth values to the staging backend only, using separate staging credentials. Configure the signed callback and disable SMTP tracking. Set the controlled recipient override. Pause delivery (`EMAIL_ENABLED=false`) before deploying the new backend.
3. Stop/drain old staging email workers so old and new providers cannot operate on the same queue. Existing `SENT`, `FAILED` and `SKIPPED` records are not replayed. Pending jobs with no prior attempt may use Zoho. Previously attempted `PENDING` or stale `SENDING` jobs without Zoho receipts are held as `LEGACY` for review, not resent.
4. Run the operations report. Reconcile legacy sends against the **Resend dashboard** before cutover. This release intentionally has no Resend client; resolve legacy attempts through the previous release's controlled workflow or keep them held. Do not bulk-reset attempts/statuses or edit production data manually.
5. Enable staging email only when ready to deliver eligible queued jobs. Test synthetic payment confirmation, confirmed decline → delayed recovery, email recovery → OTP → prefilled application, submission notification, customer contact receipt, internal support Reply-To, and staff invitation. Confirm recognizable URLs and unchanged templates/footer.
6. Test controlled Gmail, Outlook and Yahoo inboxes: delivery versus spam, code arrival before expiry, sender alignment, reply routing, buttons and absence of tracking redirects. Review provider logs for errors. No real customer email should be part of staging verification.
7. After staging passes, remove **`RESEND_API_KEY` from staging backend environment settings**; the new code already ignores it. Remove any obsolete Resend-specific settings you added outside the repository, but retain `EMAIL_*` shared settings. No frontend mail variable needs replacing.
8. At a separately authorized production cutover, repeat the worker pause/drain, legacy queue review and region/sender checks. Add production Zoho credentials; remove the staging recipient override; enable only one worker generation. No email content, past orders or historical notification markers are bulk-migrated.
9. Only after production Zoho verification **and resolution of all outstanding Resend dispatches**, remove `RESEND_API_KEY` from production and revoke the Resend key in its dashboard. Staging success alone is not a reason to remove the key from an old production release that still uses it.
10. Rollback requires pausing the new workers first and reviewing Zoho `DISPATCHING`/`UNCERTAIN`/`REVIEW` records before restoring the previous release. Never enable old Resend workers against Zoho-held jobs without transport evidence and a reviewed queue. Never run both providers against the same jobs.

The Resend package/client/mocks are removed from the new release. `EMAIL_FROM`, `EMAIL_REPLY_TO`, `EMAIL_ENABLED`, `EMAIL_RECIPIENT_OVERRIDE` (staging only), `FRONTEND_URL` and `STAFF_PORTAL_URL` remain. Render Blueprint secrets use `sync:false`; existing services need values supplied through their configuration source. No Blueprint sync, deploy, DNS change, real sending or credential revocation is performed by this code change.
