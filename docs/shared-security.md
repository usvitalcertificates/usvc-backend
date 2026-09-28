# Shared security rules (all agents)

Applies to every task in both repos. Stricter per-repo rules live in `coding-rules.md` (plus `main-website.md` / `flow-portal.md` frontend, `public-api.md` / `staff-api.md` backend) — they add to this, never relax it.

1. Never store, log, or return plaintext SSN, full card number, expiry, CVV/CVC, passwords, MFA secrets, JWT/Stripe secrets, or decrypted values — in code, docs, logs, notes, analytics, audit detail fields, emails, or projections.
2. Never put real secret **values** in `.env.example`, docs, or this repo. Env var **names** only.
3. Public tracking/confirmation/summary responses return only whitelisted public metadata + customer-safe timeline. `confidentialData` is never in a public projection (backend tests enforce this).
4. Staff reads of sensitive data go only through `POST /orders/:id/reveal` (assigned agent or ADMIN, reason required, rate-limited, audited). No shortcuts, no bulk reveal.
5. Frontend: Stripe Elements is the only collector of card fields. Never build raw card/CVV/expiry inputs. Never send SSN to analytics, logs, URLs, or browser storage (drafts exclude SSN/card).
6. Backend fails closed: missing/malformed `SENSITIVE_ENCRYPTION_KEY` blocks startup. No fallback, no default key.
7. Owner-accepted risk on record: storing PAN and especially CVC (even encrypted) violates card-network rules and triggers full PCI-DSS scope. Do not expand card storage; prefer deletion paths where possible.
8. Staff portal is an operational separation only (`flow.*` host-split). Real access control is backend authorization on every request (`requireAuth` + assigned-or-admin / `requireAdmin`).
9. Before handoff, run the repo's gates (frontend `build`; backend `build` + `test`) and confirm no secret leaked into the diff.
