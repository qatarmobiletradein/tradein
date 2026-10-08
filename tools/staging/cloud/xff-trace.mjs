// Cloud verification helper used on 2026-10-08 (see docs/evidence/cloud-extra-checks.md).
// Reads staging-tokens.json / staging-refresh.json / fixture-passwords.json from the working directory (git-ignored, never committed).
import { randomUUID } from 'node:crypto';
const API = 'https://qm-api-staging.up.railway.app';
const spoof = process.argv[2] === 'spoof';
const out = [];
for (let i = 0; i < 24; i++) {
  const ip = `203.0.113.${i + 1}`;
  const h = { 'content-type': 'application/json' }; if (spoof) Object.assign(h, { 'x-forwarded-for': ip });
  const r = await fetch(`${API}/v1/auth/staff/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: `nobody-${randomUUID().slice(0, 8)}@staff.example.test`, password: 'Wrong-password-123' }) });
  out.push(`${r.status}/${r.headers.get('x-ratelimit-remaining')}`);
}
console.log(spoof ? 'spoofed:' : 'plain:  ', out.join(' '));
