# Zoho CPaaS email migration

USVC sends all transactional emails through Zoho CPaaS India using HTTPS. The frontend never sends email directly. Existing subjects, templates, Reply-To behavior, recovery links, pricing and payment rules stay unchanged.

## Backend environment (`usvc-backend/.env` or Render API service)

Add these **server-only** values. Use a separate Agent and credentials for staging and production. Do not commit secrets or paste them into chat.

```dotenv
# Enable only after account/domain approval and configuration below.
EMAIL_ENABLED="true"
# Raw token only. Do NOT include the "Zoho-enczapikey " prefix.
ZOHO_EMAIL_API_KEY="YOUR_AGENT_SEND_TOKEN"
# Actual Agent key from Zoho; do not assume the display name/Agent Alias is the key.
ZOHO_EMAIL_AGENT_KEY="YOUR_AGENT_KEY"
ZOHO_OAUTH_CLIENT_ID="YOUR_INDIA_OAUTH_CLIENT_ID"
ZOHO_OAUTH_CLIENT_SECRET="YOUR_OAUTH_CLIENT_SECRET"
ZOHO_OAUTH_REFRESH_TOKEN="YOUR_OFFLINE_REFRESH_TOKEN"

# Keep your existing approved sender and support mailbox.
EMAIL_FROM="US Vital Certificates <noreply@usvitalcertificates.org>"
EMAIL_REPLY_TO="support@usvitalcertificates.org"
```

All five `ZOHO_*` values, sender, Reply-To and `STAFF_PORTAL_URL` are required when email is enabled. Keys are not required with `EMAIL_ENABLED="false"`; recovery remains unavailable in that mode. Do not put placeholders in an enabled deployed service.

The adapter fixes the region to `https://cpaas.zoho.in/v1.1/email`; OAuth refresh uses `https://accounts.zoho.in/oauth/v2/token`. Use India-region credentials from the account shown in your screenshot, not a US/EU OAuth client. No SMTP host, username or password is needed.

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
3. Create the send API key in the environment's Agent. Copy the raw token to `ZOHO_EMAIL_API_KEY`; use the actual Agent key for `ZOHO_EMAIL_AGENT_KEY`.
4. In Zoho's **India** API Console (`https://api-console.zoho.in/`), create a server-side/self-client appropriate for your account. Authorize **`Zeptomail.email.READ`** with offline access and exchange the authorization code using Zoho's documented flow to obtain a refresh token. Store the client ID/secret and refresh token in the backend secret store. The send token alone cannot read logs.
5. Confirm the OAuth user can read the same Agent. Authorization codes are temporary; they are not refresh tokens. Access tokens are refreshed/cached in server memory and are not a separate `.env` value. Never log token responses.
6. Explicitly leave open/click tracking disabled. The adapter also sends `track_opens:false` and `track_clicks:false`, including for private recovery links and OTPs.
7. Check the regional credit price, balance and six-month credit expiry. Enable provider low-credit notifications and purchase only the amount needed; no dedicated IP or other channels are required.

Official references: [send API](https://www.zoho.com/cpaas/help/api/email-sending.html), [authentication](https://www.zoho.com/cpaas/help/api/api-authentication.html), [email logs and read scope](https://www.zoho.com/cpaas/help/api/get-email-logs.html).

## Delivery guarantees and monitoring

The transactional outbox still commits jobs with the application event. `email_dispatches` holds permanent, non-content transport evidence separately from expiring recovery jobs. It stores opaque references, record IDs, timestamps and sanitized states; it contains no recipients, HTML, codes, tokens or provider credentials.

- `READY`: no unresolved send; a fenced worker may dispatch.
- `DISPATCHING`: a durable reservation exists. A crash cannot cause another send.
- `UNCERTAIN`: a timeout, ambiguous response or interrupted dispatch requires evidence from Zoho logs.
- `ACCEPTED`: Zoho accepted the email, either through the send response or matching logs. Outbox `SENT` and existing audit names mean accepted for delivery, **not confirmed inbox delivery**.
- `FAILED` / `SKIPPED`: terminal rejection or ineligibility; no automatic replay.
- `REVIEW`: unresolved beyond 24 hours or earlier secret expiry, or a previously attempted legacy job. Operator investigation is required.

Confirmed retryable rejection (currently an explicit structured HTTP 429 response) uses existing bounded backoff and honors `Retry-After`. Authentication/validation rejections stop. Timeouts, malformed responses and server errors never blindly resend. The first ordinary uncertain-send lookup is after one minute; crashed reservations become eligible after the two-minute sending lease. Reconciliation increases to hourly checks and stops at 24 hours or earlier message expiry. A missing/failed log lookup never proves that another send is safe. A bounce is also evidence of a prior accepted message, not permission to send again.

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
2. Add the five Zoho values to the staging backend only, using separate staging credentials. Set the controlled recipient override. Pause delivery (`EMAIL_ENABLED=false`) before deploying the new backend.
3. Stop/drain old staging email workers so old and new providers cannot operate on the same queue. Existing `SENT`, `FAILED` and `SKIPPED` records are not replayed. Pending jobs with no prior attempt may use Zoho. Previously attempted `PENDING` or stale `SENDING` jobs without Zoho receipts are held as `LEGACY` for review, not resent.
4. Run the operations report. Reconcile legacy sends against the **Resend dashboard** before cutover. This release intentionally has no Resend client; resolve legacy attempts through the previous release's controlled workflow or keep them held. Do not bulk-reset attempts/statuses or edit production data manually.
5. Enable staging email only when ready to deliver eligible queued jobs. Test synthetic payment confirmation, confirmed decline → delayed recovery, email recovery → OTP → prefilled application, submission notification, customer contact receipt, internal support Reply-To, and staff invitation. Confirm recognizable URLs and unchanged templates/footer.
6. Test controlled Gmail, Outlook and Yahoo inboxes: delivery versus spam, code arrival before expiry, sender alignment, reply routing, buttons and absence of tracking redirects. Review provider logs for errors. No real customer email should be part of staging verification.
7. After staging passes, remove **`RESEND_API_KEY` from staging backend environment settings**; the new code already ignores it. Remove any obsolete Resend-specific settings you added outside the repository, but retain `EMAIL_*` shared settings. No frontend mail variable needs replacing.
8. At a separately authorized production cutover, repeat the worker pause/drain, legacy queue review and region/sender checks. Add production Zoho credentials; remove the staging recipient override; enable only one worker generation. No email content, past orders or historical notification markers are bulk-migrated.
9. Only after production Zoho verification **and resolution of all outstanding Resend dispatches**, remove `RESEND_API_KEY` from production and revoke the Resend key in its dashboard. Staging success alone is not a reason to remove the key from an old production release that still uses it.
10. Rollback requires pausing the new workers first and reviewing Zoho `DISPATCHING`/`UNCERTAIN`/`REVIEW` records before restoring the previous release. Never enable old Resend workers against Zoho-held jobs without transport evidence and a reviewed queue. Never run both providers against the same jobs.

The Resend package/client/mocks are removed from the new release. `EMAIL_FROM`, `EMAIL_REPLY_TO`, `EMAIL_ENABLED`, `EMAIL_RECIPIENT_OVERRIDE` (staging only), `FRONTEND_URL` and `STAFF_PORTAL_URL` remain. Render Blueprint secrets use `sync:false`; existing services need values supplied through their configuration source. No Blueprint sync, deploy, DNS change, real sending or credential revocation is performed by this code change.
