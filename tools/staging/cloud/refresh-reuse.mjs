// Cloud verification helper used on 2026-10-08 (see docs/evidence/cloud-extra-checks.md).
// Reads staging-tokens.json / staging-refresh.json / fixture-passwords.json from the working directory (git-ignored, never committed).
import { readFileSync, writeFileSync } from 'node:fs';
const API = 'https://qm-api-staging.up.railway.app';
const R = JSON.parse(readFileSync('staging-refresh.json', 'utf8')), T = JSON.parse(readFileSync('staging-tokens.json', 'utf8'));
const post = async (p, b) => { const r = await fetch(`${API}/v1/auth/${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
const me = async (t) => (await fetch(`${API}/v1/actions/me.context`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: '{}' })).status;
const old = R['USR-00003'];
const r1 = await post('refresh', { refreshToken: old });
const m1 = r1.body.token ? await me(r1.body.token) : 0;
await new Promise((d) => setTimeout(d, 20000));
const reuse = await post('refresh', { refreshToken: old });
const pass = r1.status === 200 && m1 === 200 && reuse.status !== 200;
console.log(pass ? 'PASS' : 'FAIL', 'X-05 refresh via API works; reusing the spent refresh token after the reuse window is refused', `refresh=${r1.status} newToken=${m1} reuseAfter20s=${reuse.status}`);
const res = JSON.parse(readFileSync('extra-results.json', 'utf8')).map((x) => x.id === 'X-05' ? { id: 'X-05', name: 'refresh via the API returns a working token; the spent refresh token is refused after Supabase\'s reuse window', result: pass ? 'PASS' : 'FAIL', detail: `refresh=${r1.status} newToken=${m1} reuseAfter20s=${reuse.status} (immediate reuse inside the window is accepted by Supabase by design)` } : x);
writeFileSync('extra-results.json', JSON.stringify(res, null, 1));
