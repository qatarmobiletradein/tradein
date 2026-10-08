# Staging verification report

- **kind**: LOCAL EMULATION (GoTrue + PostgREST images, emulated gateway/Storage/Twilio) — NOT Supabase Cloud
- **api**: http://127.0.0.1:18081

**PASS 16 · FAIL 0 · SKIPPED 0**

| Status | ID | Check | Detail |
|---|---|---|---|
| PASS | E-01 | real sign-in for 11 seeded profiles: customers by SMS code, staff by e-mailed code + password | 11 signed in |
| PASS | E-11 | staff sign in again with email + password through the real Auth server; the token is a password session | amr=password |
| PASS | E-02 | GoTrue-issued token: HS256, issuer and audience as configured, role authenticated |  |
| PASS | E-03 | profiles were linked to their Supabase Auth users on first verified sign-in |  |
| PASS | E-10 | the resend cooldown reaches the person as a 429 sentence, quickly (hook → Auth → API) | 12 ms |
| PASS | E-04 | refresh through the real Auth server issues a working token (staff: still a password session) |  |
| PASS | E-12 | staff number: Supabase Auth called DIRECTLY for an SMS code is refused by the hook; nothing is sent | GoTrue answered 422 |
| PASS | E-13 | a password-RECOVERY session (code verified directly with Supabase Auth) is not a staff session |  |
| PASS | E-14 | someone signs up DIRECTLY with a staff address first: the unconfirmed stray user is cleared, the owner sets up normally, the stray password never works |  |
| PASS | E-15 | administrator changes a staff address: old address refused, old password does not carry over, new address set up |  |
| PASS | E-16 | wrong passwords pause sign-in for that address even with the real Auth server; the right password is then refused too |  |
| PASS | E-05 | Railway pre-checks cannot be bypassed by calling Supabase Auth directly (disabled account) | GoTrue answered 403: This account cannot sign in. |
| PASS | E-06 | a Supabase session for a number with no profile is useless to the API and to direct REST |  |
| PASS | E-07 | wrong-code limit with the real Auth server: right code refused after 5 wrong ones |  |
| PASS | E-08 | logout-all: old access token refused; refresh token revoked by the Auth server |  |
| PASS | E-09 | the Send SMS hook rejects unsigned calls coming through the public gateway |  |
