# Staff email (password set/reset codes) — configuration

**Status: NOT CONFIGURED** (by instruction: "Do not configure Microsoft Graph yet"). Staff password set/reset by email code was **not executed** on the cloud. Staff sign-in with an existing password works.

## What sends the email today
Supabase Auth's built-in sender. On the real project it refused the fictional `.test` addresses and then hit its hourly limit; nothing was delivered. The built-in sender is only meant for the project's own team members, so it is **not** a production option. *(Exact limits are Supabase's and may change — verify in the dashboard.)*

## Recommended: Microsoft Graph, app-only, sending as `info@qatarmobile.qa`
Why not SMTP with the mailbox password: Microsoft is retiring Basic authentication for SMTP AUTH in Exchange Online (announced in message-centre post MC786329; *I believe the current plan disables it by default around the end of 2026 — verify the date on Microsoft's site*). A normal mailbox password must never be placed in code, Git, documentation, chat or Railway.

### Exactly what is needed from the Microsoft 365 admin (no passwords)
1. **App registration** in Entra ID, e.g. `QM Trade-In Staff Mail`, single tenant.
2. **API permission:** Microsoft Graph → *Application* permission **`Mail.Send`**, with **admin consent**.
3. **Restrict the app to the one mailbox** `info@qatarmobile.qa` — Exchange **RBAC for Applications** (Microsoft's newer method — *verify current guidance*) or the older **Application Access Policy** (`New-ApplicationAccessPolicy -AccessRight RestrictAccess`). Without this, `Mail.Send` could send as any mailbox in the tenant.
4. **Credential for the app:** a **client secret** (simplest; set an expiry, e.g. 12 months, and a renewal reminder) or a certificate (stronger).
5. Values to enter **directly in Railway** (qm-api → Variables, sealed where marked) — never in chat:
   | Variable | Value | Secret |
   |---|---|---|
   | `GRAPH_TENANT_ID` | Directory (tenant) ID | no |
   | `GRAPH_CLIENT_ID` | Application (client) ID | no |
   | `GRAPH_CLIENT_SECRET` | the client secret value | **yes — seal** |
   | `STAFF_MAIL_FROM` | `info@qatarmobile.qa` | no |

### What will be built once allowed (not built yet)
- Supabase Auth **Send Email hook** → `POST https://<api>/v1/hooks/send-email` (signed with a hook secret, `SEND_EMAIL_HOOK_SECRET`, like the SMS hook).
- The API sends only the **recovery code** e-mail for **active staff** addresses, through Graph `POST /users/info@qatarmobile.qa/sendMail`, with its existing limits (per-address cooldown, `STAFF_RESET_EMAILS_PER_HOUR=25` platform-wide). No bulk email. The code is never logged.
- Reset Password template body must include `{{ .Token }}`.
- Tests to run on the cloud then: code delivered to a real staff test mailbox, code accepted once, wrong code limits, a recovery session cannot become a staff session, expired code refused.

## Alternative (if Graph is not possible)
A transactional email provider (e.g. one with an API key and a verified `qatarmobile.qa` sending domain with SPF/DKIM) configured as Supabase **custom SMTP**. This needs DNS records on `qatarmobile.qa` — not done in this phase (no DNS changes allowed).
