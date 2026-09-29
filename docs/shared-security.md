# Shared security rules (all agents)

Applies to every task in both repos. Stricter per-repo rules live in `coding-rules.md` (plus `main-website.md` / `flow-portal.md` frontend, `public-api.md` / `staff-api.md` backend) — they add to this, never relax it.

1. Never store, log, or return plaintext customer PII, passwords, MFA secrets, JWT/Stripe secrets, or decrypted values — in code, docs, logs, notes, analytics, audit detail fields, emails, or projections.
2. Never put real secret **values** in `.env.example`, docs, or this repo. Env var **names** only.
3. Public tracking/confirmation/summary responses return only whitelisted public metadata + customer-safe timeline.
4. Staff reads of sensitive order data go only through authorized, audit-logged endpoints. No shortcuts, no bulk reads. Handling policy TBD — pending owner decision. See code, not docs.
5. Frontend: Stripe Elements is the only collector of card fields. Never build raw card/CVV/expiry inputs. Never send sensitive form fields to analytics, logs, URLs, or browser storage (drafts exclude sensitive fields).
6. Backend fails closed: missing/malformed `SENSITIVE_ENCRYPTION_KEY` blocks startup. No fallback, no default key.
7. Staff portal is an operational separation only (`flow.*` host-split). Real access control is backend authorization on every request (`requireAuth` + assigned-or-admin / `requireAdmin`).
8. Before handoff, run the repo's gates (frontend `build`; backend `build` + `test`) and confirm no secret leaked into the diff.
