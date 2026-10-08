# Staging deployment — step by step

**Status: prepared, NOT performed.** No Supabase or Railway account was available to this work, so nothing below has been run in the cloud. Everything that can run without an account was run locally (see `STAGING_TEST_RESULTS.md`). Production is untouched and out of scope: do not migrate production data, do not disable Apps Script, do not change DNS, customer URLs or production SMS.

Settings and variable names: `CLOUD_CONFIGURATION.md`. Placeholders look like `<staging-ref>`.

## 0. Before you start
- Operator machine: Node 22 (≥ 20.11), npm, git. Optional: Railway CLI ≥ 5.42.1 (only for `.railway/railway.ts`), Docker (only for the local emulation).
- Accounts: Supabase (new **staging** project), Railway (new **staging** project), Twilio (or your SMS gateway) — with a sender allowed to text Qatar numbers *(verify Twilio's rules for Qatar)* — and an **SMTP** mailbox/service for the staff password e-mails (Supabase's built-in e-mail only reaches the project's team members, 2 per hour).
- Testers: staff testers need a **work email** each (staff sign in with email + password); customer testers need a real handset (SMS code). Up to 7 staff addresses and 2 customer numbers go into `staging-testers.json` (git-ignored), never into the repository.
- Unpack the ZIP and check it builds and passes locally:
  ```bash
  npm ci
  npm run typecheck && npm run build
  npm run test:db            # 161 tests, throwaway PostgreSQL (needs PG 16 server binaries)
  ```

## 1. Create the Supabase staging project (dashboard)
1. New project → name `qatar-mobile-tradein-staging`, region per `CLOUD_CONFIGURATION.md` §2, generate a strong database password and store it in your password manager.
2. Database settings → SSL configuration → enable **Enforce SSL** → **download the CA certificate** (keep the file; it goes into `DATABASE_SSL_CA`).
3. Connect dialog → copy the **session pooler** URI (port 5432) and, if your network has IPv6, the **direct** URI.
4. API keys → create a **publishable** and a **secret** key *(verify the screen name)*.
5. Auth → signing keys → note the **JWKS URL** `https://<staging-ref>.supabase.co/auth/v1/.well-known/jwks.json`.
6. Auth → Phone → enable. OTP length 6, expiry 300 s. Turn off anonymous sign-ins and unused providers.
7. Auth → Email → enable, "Confirm email" on. Password: minimum 12, letters + digits, leaked-password protection if your plan has it, **"Require current password when changing password" off**. Email OTP expiry 900 s.
8. Auth → SMTP → your SMTP server (sender on your domain). Auth → Rate Limits → raise the e-mail limit above Supabase's starting 30/hour if many staff will reset at once.
9. Auth → Email templates → **Reset password** → the subject and body in `CLOUD_CONFIGURATION.md` ("Reset password e-mail template") — it must contain `{{ .Token }}`.
10. Leave the Send SMS hook for step 5 (it needs the Railway URL).

## 2. Apply the migrations to staging (operator terminal)
```bash
read -rs DB_PW                 # paste the staging database password; nothing is echoed
export DATABASE_URL="postgresql://postgres.<staging-ref>:${DB_PW}@<session-pooler-host>:5432/postgres"
export DATABASE_SSL=require
export DATABASE_SSL_CA="$(cat <path-to-downloaded-ca.crt>)"
export QM_PROTECTED_TARGETS="<production-ref-if-any>"   # refuses production outright
export MIGRATION_TARGET_CONFIRM="<staging-ref>"          # the command prints the target first
npm run migrate                # applies 8 migrations, each in its own transaction
npm run migrate                # must print {"applied":0,"alreadyApplied":8}
```
- The command prints `target: postgres.<staging-ref>@…/postgres [project <staging-ref>] (supabase-session-pooler)` and refuses if the ref does not match, if the target is protected, if it is the transaction pooler, if the URL carries connection-changing parameters, or if `PGHOST`/`PGUSER`/… are set in your shell.
- A `WARNING: qm: storage policy qm_catalog_media_read NOT created` line is acceptable (optional policy; see `CLOUD_CONFIGURATION.md` §2). Any **error** stops the run, rolls back that migration, and must be resolved before continuing.
- Highest-risk statements on a real Supabase (they passed only in the local emulation with an assumed privilege model): foreign keys to `auth.users` (needs REFERENCES), `insert into storage.buckets`, `alter default privileges`. If one fails, stop and report the exact error.
- Supabase CLI alternative (`supabase link --project-ref <staging-ref>` then `supabase db push`) — **not tested**; use one method per database, never both.

## 3. Load the staging seed (fictional data only)
```bash
cp staging-testers.example.json staging-testers.json   # then edit: staff profile → work email, customer → mobile number
APP_ENV=staging npm run seed:staging -- --testers staging-testers.json
```
Refuses unless `APP_ENV=staging` (development/test are accepted only for local rehearsals), refuses a database holding non-seed partners, prints numbers and addresses masked (`••••1234`, `a•••@domain`). Re-running is safe. Seeded staff you do not map keep fictional `@staff.example.test` addresses (undeliverable). Seeded: SUPER_ADMIN, finance (QM_ADMIN), QM operations admin, technician, partner admin ×2 (two partners), branch manager, branch staff ×2 (two branches), customers ×2, catalogue, prices, fee rules. Trade-ins, vouchers and settlements are created by the verification (through the API, so audit and money rules apply).

## 4. Create the Railway staging service
Dashboard path (recommended for the first deployment):
1. New project `qatar-mobile-tradein-staging` (dedicated) → New service → from your GitHub repository (root directory `/`), or create an empty service and deploy with `railway up` from the unpacked folder.
2. Railway builds the `Dockerfile` automatically. No start-command override is needed (`CMD node dist/apps/api/src/server.js`).
3. Settings → Health check path `/ready`, timeout 60 s; restart policy on failure.
4. Settings → Networking → **Generate domain** (this is `<railway-staging-domain>`). If `DATABASE_URL` is the *direct* connection, also enable **outbound IPv6**.
5. Variables → add everything in `CLOUD_CONFIGURATION.md` §1 "Railway service". **Seal** every SECRET. Leave `SEND_SMS_HOOK_SECRET` for step 5. Do not set `PORT`.
6. Deploy. In the logs expect `"msg":"qm-api listening"`; a configuration problem logs `Refusing to start:` with the variable names (never values).

Until the hook secret exists the server refuses to start (staging requires it). Either create the hook first with a temporary URL, or deploy, read the domain, then do step 5 and redeploy.

Infrastructure-as-code path (optional, after the first deployment works): `railway config plan` then `railway config apply` with `.railway/railway.ts`. It keeps every secret as `preserve()`, refuses the `production` environment, and **deletes resources that are not in the file** — review the plan.

```bash
curl -s https://<railway-staging-domain>/health   # {"ok":true,"service":"qm-api","status":"up"}
curl -s https://<railway-staging-domain>/ready    # {"ok":true,"environment":"staging",...,"database":true,"sms":"configured","idempotencyKeysRequired":true}
```

## 5. Connect Supabase Auth to the API (Send SMS hook)
1. Supabase → Auth → Hooks → **Send SMS** → HTTPS → URL `https://<railway-staging-domain>/v1/hooks/send-sms` → generate the secret.
2. Railway → `SEND_SMS_HOOK_SECRET` = that secret (sealed) → redeploy.
3. Test with one tester: the frontend (step 6) or `npm run verify:staging -- --login …` (step 7) sends a real SMS.

The hook answers success with `200 {}` and a refusal with `200 {"error":{"http_code":429,"message":"…"}}`, which Supabase Auth relays to the caller (verified against the open-source Auth server v2.170.0 locally; **not yet against Supabase Cloud**).

## 6. Staging frontend
```bash
QM_API_BASE=https://<railway-staging-domain> QM_TRANSPORT=railway QM_ENVIRONMENT_LABEL=STAGING QM_STAFF_SIGN_IN=password npm run web:build
# → dist/web/index.html (contains only the API URL, labels and the staff sign-in method)
```
Host that single file on any HTTPS static host (for example the Netlify account you already use, as a separate staging site). Put its origin in `CORS_ALLOWED_ORIGINS` and redeploy the API. Keep the Apps Script app live and unchanged.

**Staff first sign-in** (every staff member, once): sign-in screen → "Staff sign-in (email and password)" → "Set or reset password" → work email → code from the e-mail + new password → signed in. The API creates the person's Supabase Auth user at that moment (only for an ACTIVE staff profile with that address). Forgotten passwords use the same link.

## 7. Run the staging verification
```bash
export SUPABASE_URL=https://<staging-ref>.supabase.co
export SUPABASE_PUBLISHABLE_KEY=<publishable key>        # browser-safe key: used for the direct RLS checks
read -rs DB_PW; export STAGING_DATABASE_URL="postgresql://postgres.<staging-ref>:${DB_PW}@<session-pooler-host>:5432/postgres"
export DATABASE_SSL=require DATABASE_SSL_CA="$(cat <ca.crt>)" QM_PROTECTED_TARGETS="<production-ref-if-any>"
npm run build
npm run verify:staging -- --api https://<railway-staging-domain> --login --testers staging-testers.json
```
- `--login`: for each **customer** tester it sends a real SMS code and asks you to type it; for each **staff** tester it asks for the password without echoing it (type `reset` instead to have a code e-mailed and choose a new password). Profiles you skip make their checks SKIPPED, never PASS.
- It refuses unless `/ready` reports `environment: staging` (it never accepts `production`), refuses hosts listed in `QM_PROTECTED_TARGETS`, runs every database query in a READ ONLY transaction, and refuses a database without the staging marker.
- Report: `staging-reports/verify-<time>.md/.json`. The run creates fictional records (IMEIs starting `99`).
- For the expired-token check, keep one token from a run and pass it next day as `QM_EXPIRED_TOKEN`.
- Repeat the browser check by hand: a customer signs in with an SMS code; finance and a branch manager sign in with email + password (one of them through "Set or reset password").
- A-14 is the important cloud-only check for staff sign-in: it confirms that Supabase Cloud's tokens carry `amr: password` and the `email` claim, which the API requires for staff.

## 8. Record the result
Fill `PRE_PRODUCTION_CHECKLIST.md` with the report file names. Anything FAIL blocks; anything SKIPPED needs a written reason.

## Rollback (staging)
- Code: Railway → Deployments → redeploy the previous deployment.
- Database: migrations are forward-only. For staging the clean rollback is a **new staging project** (or restoring a backup *(verify plan features)*), then steps 2–3 again. Never hand-edit `app.schema_migrations`.
- Auth: disable the Send SMS hook to stop all customer sign-ins immediately; disable the Email provider to stop staff sign-ins.
