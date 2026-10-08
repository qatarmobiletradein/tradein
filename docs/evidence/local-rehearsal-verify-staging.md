# Staging verification report

- **api**: http://127.0.0.1:39411
- **environment**: test
- **startedAt**: 2026-10-08T01:33:22.777Z
- **signedInProfiles**: CUS-00001, CUS-00002, USR-00001, USR-00002, USR-00003, USR-00004, USR-00005, USR-00006, USR-00007, USR-00008, USR-00009
- **supabaseDirectChecks**: not configured (SKIPPED)
- **databaseChecks**: read-only: postgres@127.0.0.1:54329/qm_t_ae80cc99b788 (local)

**PASS 77 · FAIL 0 · SKIPPED 3**

| Status | ID | Check | Detail |
|---|---|---|---|
| PASS | P-01 | GET /health answers without secrets |  |
| PASS | P-02 | GET /ready confirms the database (no internals) | environment=test, sms=configured |
| PASS | P-03 | idempotency keys are required in this environment |  |
| PASS | P-07 | staff sign in with email and password (owner decision) |  |
| PASS | P-04 | secure headers present; no X-Powered-By |  |
| PASS | P-05 | CORS does not echo an unknown origin |  |
| PASS | P-06 | unknown route → generic 404 JSON; malformed body → sentence, no stack |  |
| PASS | A-ME-USR-00001 | platform owner: token accepted, role/scope from the database |  |
| PASS | A-ME-USR-00002 | finance (QM admin): token accepted, role/scope from the database |  |
| PASS | A-ME-USR-00003 | technician: token accepted, role/scope from the database |  |
| PASS | A-ME-USR-00004 | partner-wide admin (VND-001): token accepted, role/scope from the database |  |
| PASS | A-ME-USR-00005 | branch manager (BR-0001): token accepted, role/scope from the database |  |
| PASS | A-ME-USR-00006 | branch staff (BR-0002): token accepted, role/scope from the database |  |
| PASS | A-ME-USR-00007 | QM operations admin: token accepted, role/scope from the database |  |
| PASS | A-ME-USR-00008 | branch staff (BR-0001): token accepted, role/scope from the database |  |
| PASS | A-ME-USR-00009 | second partner admin (VND-002): token accepted, role/scope from the database |  |
| PASS | A-ME-CUS-00001 | customer: token accepted, role/scope from the database |  |
| PASS | A-ME-CUS-00002 | second customer: token accepted, role/scope from the database |  |
| PASS | A-01 | token claims match the configured issuer/audience (decoded, not trusted) | alg=HS256 iss= aud="authenticated" |
| PASS | A-02 | no token → 401 |  |
| PASS | A-03 | garbage token → 401 |  |
| PASS | A-04 | tampered signature → 401 |  |
| PASS | A-05 | tampered claims (role escalated) → 401 |  |
| PASS | A-06 | alg "none" token → 401 |  |
| PASS | A-07 | expired token → 401 |  |
| SKIPPED | A-08 | the publishable/anon key is not accepted as a user token | SUPABASE_PUBLISHABLE_KEY not set |
| PASS | A-09 | sign-in endpoints are rate limited and never return a code |  |
| PASS | A-10 | a staff number cannot get an SMS code (told to use staff sign-in) |  |
| PASS | A-11 | wrong password and unknown address get the same answer |  |
| PASS | A-12 | "set or reset password" gives the same reply for an unknown address and sends nothing |  |
| PASS | A-13 | repeated wrong passwords pause sign-in for that address (429) |  |
| PASS | A-14 | a Supabase password session carries amr=password and the email claim (what the API relies on) | amr=password |
| PASS | I-01 | missing Idempotency-Key on trade-in creation (customer.submitTradeIn) → 428, nothing done |  |
| PASS | I-02 | missing Idempotency-Key on offer acceptance (customer.acceptOffer) → 428, nothing done |  |
| PASS | I-03 | missing Idempotency-Key on device received (tech.receiveDevice) → 428, nothing done |  |
| PASS | I-04 | missing Idempotency-Key on voucher issue (vendor.issueVoucher) → 428, nothing done |  |
| PASS | I-05 | missing Idempotency-Key on voucher cancel (vendor.voidVoucher) → 428, nothing done |  |
| PASS | I-06 | missing Idempotency-Key on voucher reissue (vendor.voidVoucher) → 428, nothing done |  |
| PASS | I-07 | missing Idempotency-Key on collection (create note) (admin.createBatch) → 428, nothing done |  |
| PASS | I-08 | missing Idempotency-Key on collection (mark collected) (admin.updateBatch) → 428, nothing done |  |
| PASS | I-09 | missing Idempotency-Key on settlement creation (admin.createSettlement) → 428, nothing done |  |
| PASS | I-10 | missing Idempotency-Key on settlement approval (admin.advanceSettlement) → 428, nothing done |  |
| PASS | I-11 | read-only endpoints do not need a key |  |
| PASS | I-12 | a malformed key is refused before anything runs |  |
| PASS | F-01 | customer creates a trade-in (state, scope, audit, replay) | TI-DEMO-000001; audit TRADEIN_CREATED by CUS-00001 |
| PASS | F-02 | inspection + offer by the technician (financial values) | value 2000, fee 100, total 2100 QAR |
| PASS | F-03 | customer accepts (replay safe; other customer refused) | audit CUSTOMER_ACCEPTED by CUS-00001 |
| PASS | F-04 | technician confirms the device is received | audit DEVICE_RECEIVED by USR-00003 |
| PASS | F-05 | branch issues the voucher (other branch refused; duplicate prevented) | voucher DEMO-20261008-0001 |
| PASS | F-06 | Qatar Mobile collects the device (note + mark collected) | BAT-00001; audit DEVICE_COLLECTED by USR-00002 |
| PASS | F-07 | finance creates and submits the settlement (totals add up) | STL-00001: 1 line(s), 2100 QAR |
| PASS | F-08 | settlement approval: QM admin refused, platform owner approves, finance pays | approved by USR-00001, paid |
| PASS | N-01 | branch user → another branch's trade-in: denied |  |
| PASS | N-02 | branch user cannot reach another branch by changing the branch id |  |
| PASS | N-03 | partner user → another partner's trade-in: denied |  |
| PASS | N-04 | lower role modifies SUPER_ADMIN: denied (and nothing changes) |  |
| PASS | N-05 | duplicate IMEI: second open trade-in refused |  |
| PASS | N-06 | same key + same device + different payload → 409 (nothing created) |  |
| PASS | N-07 | duplicate collection: a device already on an open note is not claimed again |  |
| PASS | N-08 | duplicate settlement: a settled device is not claimed again | first 200, second 422 (There is nothing collected and unsettled in that period.) |
| PASS | N-09 | invalid state transitions are refused |  |
| PASS | N-10 | unauthorised finance actions are refused |  |
| PASS | N-11 | customer cannot act as staff |  |
| PASS | C-01 | same IMEI × 5 at once → exactly one trade-in |  |
| PASS | C-02 | same voucher issue × 5 at once → exactly one live voucher |  |
| PASS | C-03 | same collection × 3 at once → each device on one note only |  |
| PASS | C-04 | same settlement × 3 at once → each device in one settlement only | 1 created, 2 device(s) claimed once each |
| PASS | C-05 | same idempotency key × 5 at once → one effect, same answer |  |
| PASS | C-06 | void + reissue: one live voucher, chain linked (replay safe) |  |
| SKIPPED | R-* | direct Supabase REST checks | set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY |
| PASS | S-01 | technician uploads an evidence photo; a disguised SVG is refused |  |
| PASS | S-02 | private photo: short-lived signed URL works; scope enforced |  |
| SKIPPED | S-03 | private bucket is not public; not listable or readable directly | SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY not set |
| PASS | S-04 | public catalogue image is served publicly; uploads only via the API |  |
| PASS | D-01 | integrity invariants hold (reconciliation checks, read-only) |  |
| PASS | D-02 | financial totals: every settlement header equals its lines; every trade-in total = value + fee | 4 settled trade-in(s), 8400.00 QAR in settlements |
| PASS | D-03 | RLS is enabled on every public table; clients have no write grants |  |
| PASS | D-04 | storage buckets: catalogue public, evidence private, limits set |  |
| PASS | D-05 | migrations: all applied, checksums recorded | 20261008000100, 20261008000200, 20261008000300, 20261008000400, 20261008000500, 20261008000600, 20261008000700, 20261008000800 |
| PASS | D-06 | no OTP code or token stored in the OTP log or audit |  |
