# Cloud extra checks — 2026-10-08 (Railway staging → Supabase)

API `https://qm-api-staging.up.railway.app`, commit `d92222b`. Real Supabase tokens (see REAL_STAGING_RESULTS.md §3 for how fixtures were signed in). No token, password or code appears below.

| Result | ID | Check | Evidence |
|---|---|---|---|
| PASS | X-01 | disabled staff: existing token refused at once; password sign-in refused | before=200 disable=200 tokenAfter=401 login=422 |
| PASS | X-02 | re-enabled staff: the pre-disable token stays dead; a new sign-in works | enable=200 oldToken=401 newLogin=200 newToken=200 |
| PASS | X-03 | disabled customer: existing token and a NEW Supabase token are both refused by the API | disable=200 tokenAfter=401 newSupabaseToken(200)→401 |
| PASS | X-04 | re-enabled customer: a new sign-in works again | enable=200 newToken=200 |
| FAIL | X-05 | refresh via the API returns a working token; the spent refresh token is refused after Supabase's reuse window | refresh=200 newToken=200 reuseAfter20s=200 (immediate reuse inside the window is accepted by Supabase by design) — Supabase accepted the spent refresh token 20 s later: refresh-token reuse detection appears OFF (or reuse interval > 20 s) in Supabase Auth settings. The API forwards refresh to Supabase unchanged. |
| PASS | X-06 | sign out everywhere: that token and its refresh token stop working; other users unaffected | logoutAll=200 tokenAfter=401 refreshAfter=401 otherUser=200 |
| PASS | X-07 | a client-supplied X-Forwarded-For does not get around the API per-IP sign-in limit | 24 attempts, each with a different spoofed X-Forwarded-For: one shared counter 19→0, then 429 at attempt 21 (same as without the header). First run was inconclusive: the test machine egresses from 2 IPs (a plain run alternates two counters). |

# Database checks D-01…D-06 (read-only SQL through the Supabase connector)

| Result | ID | Check | Evidence |
|---|---|---|---|
| PASS | D-01 | 12 reconciliation invariants | 0 issues in every check (live vouchers, voucher links, open IMEI, settlement count/total, cancelled/paid settlements, collection lines, trade-in total, orphan photos) |
| PASS | D-02 | settlement header = sum of lines; trade-in total = value + fee | 4 settled trade-ins, 8,400 QAR: STL-00001 PAID 1×2,100 · STL-00002 DRAFT 1×2,100 · STL-00003 DRAFT 2×4,200 |
| PASS | D-03 | RLS on every public table; no client write grants | rls_off=0, client_write_grants=0 |
| PASS | D-04 | buckets | catalog-media public 2 MB; inspection-photos private 4 MB; image MIME types only |
| PASS | D-05 | migrations | 11 recorded with checksums |
| PASS | D-06 | no secrets in audit | 0 of 180 audit rows contain a JWT |
| PASS | DB-03 | ID counters not behind data | 0 |
