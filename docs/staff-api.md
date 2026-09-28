# Staff API (authorized only)

## Auth (`/auth`, `/admin/staff/:id/password-reset`)

- `POST /auth/login {email, password(8+)}` → `{mfaRequired, enroll, mfaToken(10m)}`; failures audited, 5/15min lockout.
- `POST /auth/mfa/enroll {mfaToken}` → secret + otpauth URL + QR (once). `POST /auth/mfa/confirm {mfaToken, code}` → 30m access + 7d refresh. `POST /auth/mfa/verify {mfaToken, code}` → same (daily).
- `POST /auth/refresh` (rotates; refuses pre-revocation tokens). `POST /auth/logout` (clears refresh hash, idempotent).
- `POST /auth/invite {fullName, email, role ADMIN|FULFILLMENT|CS (default FULFILLMENT)}` (ADMIN-only; email-enabled → outbox + `{id, emailed:true}`, else 48h `setupToken`). `POST /auth/invite/:id/resend` (ADMIN-only, regenerates + re-queues).
- `POST /auth/setup {token, password}` (invite or active-reset; revokes sessions, distinct audit). `POST /auth/password {currentPassword, newPassword 8+}` (signed-in ADMIN self-change; revokes all incl. caller). `POST /admin/staff/:id/password-reset` (ADMIN-only, active non-self, 48h link, emailed or manual).

## Queue + fulfillment (`/staff`, `/orders/:id/...`)

- `GET /staff/orders?search&status&certificate&rushOnly&assigned=mine|unassigned|all&openOnly&attentionFirst&page` — all roles see all paid orders (masked rows); fixed `limit=25` (no `limit` param); FIFO `createdAt`, attention-first optional. Auth endpoints share a 20/15min limiter.
- `GET /staff/analytics` — self only (ID from token; date/workflow/pagination params).
- `POST /staff/orders/:id/claim` — atomic `findOneAndUpdate {_id, assignedTo: null, paymentStatus: "PAID"}` (409 if taken). `POST .../release` (owner/ADMIN). `POST .../reassign {staffId}` (ADMIN-only, active agent).
- `GET /staff/orders/:id` — owner-or-ADMIN (CS opens owned like fulfillment); SSN/card `*********`; pricing + `amountCents` only to ADMIN/CS.
- `POST /staff/orders/:id/notes {text 1–2000}` — owner/ADMIN, internal only.
- `PATCH /staff/orders/:id/correction` — CS-owner or ADMIN, EDIT-only full-form fix; blocked on `SUBMITTED`/`CANCELLED`; copies/rush/certificate/state/pricing are locked (omitted, not validated); validated like new submission; 422 `{message, errors}`; SSN/card re-encrypted, audited by field name only. CS must claim first.
- `PATCH /orders/:id/status` — `PAID→IN_REVIEW→SUBMITTED` + `IN_REVIEW→TO_CS` (note required, optional substatus, auto-releases) + `TO_CS→GTG` (CS-owner/ADMIN, note optional, clears substatus, drops ownership) → `GTG→IN_REVIEW` (owner/ADMIN). Paid only. `SUBMITTED` queues one `SUBMISSION_NOTIFICATION` (email-enabled) and needs PDF + ≥1 note for non-ADMIN (a CS owner with both can also submit — current behavior).
- Documents (owner/ADMIN, single GridFS PDF in `order_docs` bucket, 10MB, `%PDF-` magic bytes): `POST /orders/:id/document` (upload/replace, deletes old chunks), `GET` (streams as attachment with `content-disposition`, audited), `DELETE` (audited).
- `POST /orders/:id/reveal {field: ssn|card, reason}` — assigned-or-ADMIN, rate-limited 10/15min per IP, returns plaintext once, audited. `GET /orders/:id/audit` — owner/ADMIN, sanitized events only.

## Admin (`/admin`)

`GET /admin/staff` (roster + workload, no secrets); `GET /admin/staff/:id/analytics?from&to&status&page&limit` (audit-derived KPIs + masked order metadata); `GET /admin/order-activity?search&page&limit(1–100, default 20)` (index + counts + latest); `GET /admin/order-activity/:id` (sanitized timeline + actor identity); `PATCH /admin/staff/:id` (rename, `active|disabled` only, role change; role change revokes sessions; last-ADMIN guard; self blocked); `POST /admin/staff/:id/revoke`; `POST /admin/staff/:id/mfa-reset` (clears TOTP + revokes, audited); `GET /admin/workload`; `GET /admin/activity?staffId&action&limit(1–200, default 100)`.
