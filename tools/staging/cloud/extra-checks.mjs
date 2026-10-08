// Cloud verification helper used on 2026-10-08 (see docs/evidence/cloud-extra-checks.md).
// Reads staging-tokens.json / staging-refresh.json / fixture-passwords.json from the working directory (git-ignored, never committed).
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const API = 'https://qm-api-staging.up.railway.app', SUPA = 'https://ytniownkhjolgfplegsv.supabase.co', KEY = 'sb_publishable_7Qnvym8a8-nqF6LrqXchrw_qq8gH23Z';
const T = JSON.parse(readFileSync('staging-tokens.json', 'utf8')), R = JSON.parse(readFileSync('staging-refresh.json', 'utf8')), PW = JSON.parse(readFileSync('fixture-passwords.json', 'utf8'));
const results = [];
const rec = (id, name, pass, detail = '') => { results.push({ id, name, result: pass ? 'PASS' : 'FAIL', detail }); console.log(pass ? 'PASS' : 'FAIL', id, name, detail); };
async function call(action, token, params = {}, idem) {
  const h = { 'content-type': 'application/json' }; if (token) h.authorization = `Bearer ${token}`; if (idem) h['idempotency-key'] = idem;
  const r = await fetch(`${API}/v1/actions/${action}`, { method: 'POST', headers: h, body: JSON.stringify(params) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function auth(path, body, extraHeaders = {}) {
  const r = await fetch(`${API}/v1/auth/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...extraHeaders }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const staffLogin = (id) => auth('staff/login', { email: `${id.toLowerCase()}@staff.example.test`, password: PW[id] });
const custLogin = async (id) => { const r = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: KEY }, body: JSON.stringify({ email: `${id.toLowerCase()}@customer.example.test`, password: PW[id] }) }); return { status: r.status, body: await r.json() }; };
const owner = T['USR-00001'];

// X-01 disabled staff
{
  const before = await call('me.context', T['USR-00008']);
  const d = await call('admin.updateStaff', owner, { userId: 'USR-00008', status: 'DISABLED', reason: 'cloud verification: disable test' }, randomUUID());
  const after = await call('me.context', T['USR-00008']);
  const login = await staffLogin('USR-00008');
  rec('X-01', 'disabled staff: existing token refused at once; password sign-in refused', before.status === 200 && d.status === 200 && after.status === 401 && login.status !== 200 && !login.body.token,
    `before=${before.status} disable=${d.status} tokenAfter=${after.status} login=${login.status}`);
  const e = await call('admin.updateStaff', owner, { userId: 'USR-00008', status: 'ACTIVE', reason: 'cloud verification: re-enable' }, randomUUID());
  const old = await call('me.context', T['USR-00008']);
  const again = await staffLogin('USR-00008');
  const fresh = again.body.token ? await call('me.context', again.body.token) : { status: 0 };
  if (again.body.token) T['USR-00008'] = again.body.token;
  rec('X-02', 're-enabled staff: the pre-disable token stays dead; a new sign-in works', e.status === 200 && old.status === 401 && fresh.status === 200,
    `enable=${e.status} oldToken=${old.status} newLogin=${again.status} newToken=${fresh.status}`);
}
// X-03 disabled customer
{
  const d = await call('admin.customer', owner, { customerId: 'CUS-00002', status: 'DISABLED', reason: 'cloud verification: disable test' }, randomUUID());
  const after = await call('me.context', T['CUS-00002']);
  const relog = await custLogin('CUS-00002');
  const withNew = relog.body.access_token ? await call('me.context', relog.body.access_token) : { status: 0 };
  rec('X-03', 'disabled customer: existing token and a NEW Supabase token are both refused by the API', d.status === 200 && after.status === 401 && withNew.status === 401,
    `disable=${d.status} tokenAfter=${after.status} newSupabaseToken(${relog.status})→${withNew.status}`);
  const e = await call('admin.customer', owner, { customerId: 'CUS-00002', status: 'ACTIVE' }, randomUUID());
  const relog2 = await custLogin('CUS-00002');
  const ok = relog2.body.access_token ? await call('me.context', relog2.body.access_token) : { status: 0 };
  if (relog2.body.access_token) { T['CUS-00002'] = relog2.body.access_token; R['CUS-00002'] = relog2.body.refresh_token; }
  rec('X-04', 're-enabled customer: a new sign-in works again', e.status === 200 && ok.status === 200, `enable=${e.status} newToken=${ok.status}`);
}
// X-05 refresh through the API
{
  const rt = R['USR-00007'];
  const r = rt ? await auth('refresh', { refreshToken: rt }) : { status: 0, body: {} };
  const tok = r.body.token;
  const me = tok ? await call('me.context', tok) : { status: 0 };
  if (tok) { T['USR-00007'] = tok; if (r.body.refreshToken) R['USR-00007'] = r.body.refreshToken; }
  const reuse = rt ? await auth('refresh', { refreshToken: rt }) : { status: 0 };
  rec('X-05', 'refresh through the API returns a working token; the used refresh token cannot mint another', r.status === 200 && me.status === 200 && reuse.status !== 200,
    `refresh=${r.status} newToken=${me.status} reuseOld=${reuse.status}`);
}
// X-06 logout-all
{
  const tok = T['USR-00007'];
  const lo = await fetch(`${API}/v1/auth/logout-all`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: '{}' });
  const after = await call('me.context', tok);
  const rf = R['USR-00007'] ? await auth('refresh', { refreshToken: R['USR-00007'] }) : { status: 0 };
  const other = await call('me.context', T['USR-00001']);
  rec('X-06', 'sign out everywhere: that token and its refresh token stop working; other users unaffected', lo.status === 200 && after.status === 401 && rf.status !== 200 && other.status === 200,
    `logoutAll=${lo.status} tokenAfter=${after.status} refreshAfter=${rf.status} otherUser=${other.status}`);
  const back = await staffLogin('USR-00007'); if (back.body.token) T['USR-00007'] = back.body.token;
}
// X-07 X-Forwarded-For cannot spoof the API's per-IP sign-in limit
{
  const codes = [];
  for (let i = 0; i < 26; i++) {
    const ip = `203.0.113.${(i % 250) + 1}`;
    const r = await auth('staff/login', { email: `nobody-${randomUUID().slice(0, 8)}@staff.example.test`, password: 'Wrong-password-123' }, { 'x-forwarded-for': ip, 'x-real-ip': ip, forwarded: `for=${ip}` });
    codes.push(r.status);
  }
  const first429 = codes.indexOf(429);
  rec('X-07', 'a client-supplied X-Forwarded-For does not get around the per-IP sign-in limit', first429 > 0 && first429 <= 21,
    `26 attempts from 26 spoofed IPs → first 429 at attempt ${first429 + 1}; codes: ${[...new Set(codes)].join(',')}`);
}
writeFileSync('staging-tokens.json', JSON.stringify(T)); writeFileSync('staging-refresh.json', JSON.stringify(R));
writeFileSync('extra-results.json', JSON.stringify(results, null, 1));
