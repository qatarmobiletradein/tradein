# Evidence (local runs, 2026-10-08)

Reports written by the tools themselves during the final runs. **Local only — none of these ran on Supabase Cloud or Railway.**

| File | Produced by |
|---|---|
| `emulation-verify-staging.md` | `npm run emulate:staging` → `tools/staging/verify-staging.ts` against the containerised API (88 PASS, 0 FAIL, 0 SKIPPED) |
| `emulation-only-checks.md` | same run → `tests/staging/local-cloud/drive.ts` (16 PASS: customers by SMS code, staff by e-mailed code + password through the real open-source Supabase Auth) |
| `emulation-migrate-run1.txt`, `-run2.txt` | `npm run migrate` executed inside the shipped image (8 applied, then 0) |
| `ui-customer.png`, `ui-finance-admin.png`, `ui-branch-manager.png` | browser sign-in through Supabase Auth (GoTrue) in the emulation (customer: SMS; finance: first password from the e-mailed code; branch manager: email + password) |
| `ui-signin-screen.png`, `ui-staff-signin-form.png` | the sign-in screen with the added staff link, and the staff form (`npm run test:ui`) |
| `local-rehearsal-verify-staging.md` | `npm run rehearse:staging` (77 PASS, 3 SKIPPED) |
| `migration-rehearsal.md` | `npm run rehearse:migration` (10 PASS) |
