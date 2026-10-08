/**
 * LOCAL EMULATION ONLY — a stand-in for the parts of Supabase Cloud and
 * Twilio that sit in front of the real open-source components:
 *
 *   https://127.0.0.1:$GW_PORT/auth/v1/*     → REAL Supabase Auth (GoTrue) container
 *   https://127.0.0.1:$GW_PORT/rest/v1/*     → REAL PostgREST container
 *       (like Supabase's API gateway: an `apikey` header is required)
 *   https://127.0.0.1:$GW_PORT/storage/v1/*  → minimal Storage API emulation; object
 *       visibility for user tokens is decided by the REAL storage.objects RLS
 *       policies in PostgreSQL (queried as anon/authenticated)
 *   https://127.0.0.1:$GW_PORT/hooks/send-sms → byte-exact proxy to the API's hook
 *       (Supabase Auth calls an https hook)
 *   https://api.twilio.com (443, mapped to 127.0.0.1 inside the API container)
 *       → Twilio Messages API emulation: checks Basic auth and the form body,
 *       records the code for the test driver
 *   GET http://127.0.0.1:$CTL_PORT/sms?phone=… → last code (test driver only)
 *   smtp://127.0.0.1:$SMTP_PORT → SMTP sink standing in for the project's SMTP
 *       server: Supabase Auth (GoTrue) sends the REAL "Reset password" e-mail
 *       here; the driver reads the code from GET /mail?to=…
 *   GET http://127.0.0.1:$CTL_PORT/templates/recovery → the "Reset password"
 *       template with {{ .Token }} (what the dashboard template must contain)
 *
 * Nothing here is used outside tests/staging/local-cloud.
 */
import { createServer as createHttps } from 'node:https';
import { createServer as createHttp, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTcp } from 'node:net';
import { readFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';
import { jwtVerify, SignJWT } from 'jose';

const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} not set`); return v; };
const GW_PORT = Number(env('GW_PORT'));
const CTL_PORT = Number(env('CTL_PORT'));
const GOTRUE = `http://127.0.0.1:${env('GOTRUE_PORT')}`;
const PGRST = `http://127.0.0.1:${env('PGRST_PORT')}`;
const API = `http://127.0.0.1:${env('API_PORT')}`;
const SECRET = new TextEncoder().encode(env('JWT_SECRET'));
const ANON = env('ANON_KEY');
const SERVICE = env('SERVICE_KEY');
const TWILIO_SID = env('TWILIO_SID');
const TWILIO_TOKEN = env('TWILIO_TOKEN');
const tls = { cert: readFileSync(env('TLS_CERT')), key: readFileSync(env('TLS_KEY')) };
const db = new pg.Pool({ connectionString: env('ADMIN_DB_URL'), max: 4 });

const codes = new Map<string, string>();
const mails = new Map<string, { code: string; subject: string; count: number }>();
const SMTP_PORT = Number(env('SMTP_PORT'));
/** The template GoTrue fetches (GOTRUE_MAILER_TEMPLATES_RECOVERY) — same text as docs/CLOUD_CONFIGURATION.md. */
const RECOVERY_TEMPLATE = '<h2>Qatar Mobile staff password</h2>\n<p>Your code is <strong>{{ .Token }}</strong>. It expires in 15 minutes.</p>\n<p>If you did not ask for this, ignore this email.</p>\n';
const objects = new Map<string, { bytes: Buffer; type: string }>();

const readBody = (req: IncomingMessage) => new Promise<Buffer>((r) => { const c: Buffer[] = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

function proxy(req: IncomingMessage, res: ServerResponse, target: string, path: string, headers: Record<string, string | string[] | undefined>, body: Buffer) {
  const u = new URL(path, target);
  const out = request(u, { method: req.method, headers: { ...headers, host: u.host, 'content-length': String(body.length) } }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  out.on('error', () => json(res, 502, { message: 'upstream unavailable' }));
  out.end(body);
}

async function claimsOf(auth: string | undefined): Promise<{ role: string; sub?: string; raw: Record<string, unknown> } | null> {
  const m = /^Bearer\s+(.+)$/.exec(auth ?? '');
  if (!m) return null;
  try {
    const { payload } = await jwtVerify(m[1]!, SECRET, { algorithms: ['HS256'] });
    return { role: String(payload.role ?? ''), sub: payload.sub, raw: payload as Record<string, unknown> };
  } catch { return null; }
}

/** Run a query as the database role a token maps to, with the claims PostgREST would set. */
async function asRole<T>(claims: { role: string; raw: Record<string, unknown> } | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const role = claims?.role === 'authenticated' ? 'authenticated' : claims?.role === 'service_role' ? 'service_role' : 'anon';
  const c = await db.connect();
  try {
    await c.query('begin');
    await c.query(`set local role ${role}`);
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims?.raw ?? { role: 'anon' })]);
    return await fn(c);
  } finally {
    await c.query('rollback').catch(() => undefined);
    c.release();
  }
}

async function storage(req: IncomingMessage, res: ServerResponse, path: string, body: Buffer) {
  const claims = await claimsOf(req.headers.authorization);
  const isService = claims?.role === 'service_role' || req.headers.apikey === SERVICE && !req.headers.authorization;
  let m: RegExpExecArray | null;

  if (req.method === 'GET' && (m = /^\/object\/public\/([^/]+)\/(.+)$/.exec(path))) {
    const b = (await db.query('select public from storage.buckets where id = $1', [m[1]])).rows[0];
    const o = objects.get(`${m[1]}/${decodeURIComponent(m[2]!)}`);
    if (!b?.public || !o) return json(res, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
    res.writeHead(200, { 'content-type': o.type }); return res.end(o.bytes);
  }
  if (req.method === 'GET' && (m = /^\/object\/sign\/([^/]+)\/([^?]+)/.exec(path))) {
    const token = new URL(path, 'http://x').searchParams.get('token') ?? '';
    try {
      const { payload } = await jwtVerify(token, SECRET, { algorithms: ['HS256'] });
      const key = `${m[1]}/${decodeURIComponent(m[2]!)}`;
      if (payload.url !== key) throw new Error('url');
      const o = objects.get(key);
      if (!o) throw new Error('missing');
      res.writeHead(200, { 'content-type': o.type }); return res.end(o.bytes);
    } catch { return json(res, 400, { statusCode: '400', error: 'InvalidSignature', message: 'invalid signature' }); }
  }
  if (req.method === 'POST' && (m = /^\/object\/sign\/([^/]+)\/(.+)$/.exec(path))) {
    if (!isService) return json(res, 400, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
    const key = `${m[1]}/${decodeURIComponent(m[2]!)}`;
    if (!objects.has(key)) return json(res, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
    const ttl = Number((JSON.parse(body.toString() || '{}') as { expiresIn?: number }).expiresIn) || 60;
    const token = await new SignJWT({ url: key }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(`${ttl}s`).sign(SECRET);
    return json(res, 200, { signedURL: `/object/sign/${m[1]}/${m[2]}?token=${token}` });
  }
  if (req.method === 'GET' && (m = /^\/object\/authenticated\/([^/]+)\/(.+)$/.exec(path))) {
    const name = decodeURIComponent(m[2]!);
    const visible = await asRole(claims, async (c) => (await c.query('select 1 from storage.objects where bucket_id = $1 and name = $2', [m![1], name])).rowCount);
    const o = objects.get(`${m[1]}/${name}`);
    if (!visible || !o) return json(res, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
    res.writeHead(200, { 'content-type': o.type }); return res.end(o.bytes);
  }
  if (req.method === 'POST' && (m = /^\/object\/list\/([^/]+)$/.exec(path))) {
    const rows = await asRole(claims, async (c) => (await c.query('select name from storage.objects where bucket_id = $1 limit 100', [m![1]])).rows);
    return json(res, 200, rows);
  }
  if (req.method === 'POST' && (m = /^\/object\/([^/]+)\/(.+)$/.exec(path))) {
    const bucket = m[1]!; const name = decodeURIComponent(m[2]!);
    const b = (await db.query('select file_size_limit, allowed_mime_types from storage.buckets where id = $1', [bucket])).rows[0];
    if (!b) return json(res, 400, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' });
    const type = String(req.headers['content-type'] ?? '');
    if (b.file_size_limit && body.length > Number(b.file_size_limit)) return json(res, 413, { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' });
    if (b.allowed_mime_types && !b.allowed_mime_types.includes(type)) return json(res, 415, { statusCode: '415', error: 'invalid_mime_type', message: `mime type ${type} is not supported` });
    if (!isService) {
      // A user token can only insert what an INSERT policy allows — there is none for these buckets.
      const okInsert = await asRole(claims, async (c) => {
        try { await c.query('insert into storage.objects (bucket_id, name) values ($1, $2)', [bucket, name]); return true; } catch { return false; }
      });
      if (!okInsert) return json(res, 400, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
    }
    if (objects.has(`${bucket}/${name}`)) return json(res, 400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
    await db.query('insert into storage.objects (bucket_id, name, metadata) values ($1, $2, $3)', [bucket, name, { size: body.length, mimetype: type }]);
    objects.set(`${bucket}/${name}`, { bytes: body, type });
    return json(res, 200, { Key: `${bucket}/${name}`, Id: randomUUID() });
  }
  if (req.method === 'DELETE' && (m = /^\/object\/([^/]+)$/.exec(path))) {
    if (!isService) return json(res, 400, { statusCode: '403', error: 'Unauthorized', message: 'forbidden' });
    const prefixes = (JSON.parse(body.toString() || '{}') as { prefixes?: string[] }).prefixes ?? [];
    for (const p of prefixes) { objects.delete(`${m[1]}/${p}`); await db.query('delete from storage.objects where bucket_id = $1 and name = $2', [m[1], p]); }
    return json(res, 200, prefixes.map((name) => ({ name })));
  }
  return json(res, 404, { message: 'no route' });
}

const gateway = createHttps(tls, (req, res) => {
  void (async () => {
    const url = req.url ?? '/';
    const body = await readBody(req);
    const headers = { ...req.headers } as Record<string, string | string[] | undefined>;
    if (url.startsWith('/hooks/send-sms')) return proxy(req, res, API, '/v1/hooks/send-sms', headers, body);
    const keyed = headers.apikey === ANON || headers.apikey === SERVICE;
    if (url.startsWith('/auth/v1/')) {
      if (!keyed) return json(res, 401, { message: 'No API key found in request' });
      return proxy(req, res, GOTRUE, url.slice('/auth/v1'.length), headers, body);
    }
    if (url.startsWith('/rest/v1/')) {
      if (!keyed) return json(res, 401, { message: 'No API key found in request' });
      if (!headers.authorization) headers.authorization = `Bearer ${String(headers.apikey)}`;
      return proxy(req, res, PGRST, url.slice('/rest/v1'.length), headers, body);
    }
    if (url.startsWith('/storage/v1/')) {
      const open = /^\/storage\/v1\/object\/(public|sign)\//.test(url) && req.method === 'GET';
      if (!open && !keyed && !headers.authorization) return json(res, 401, { message: 'No API key found in request' });
      return storage(req, res, url.slice('/storage/v1'.length), body);
    }
    json(res, 404, { message: 'no route' });
  })().catch((e: Error) => json(res, 500, { message: e.message }));
});

// Twilio Messages API emulation (the API container resolves api.twilio.com to 127.0.0.1).
const twilio = createHttps(tls, (req, res) => {
  void (async () => {
    const body = await readBody(req);
    const m = /^\/2010-04-01\/Accounts\/([^/]+)\/Messages\.json$/.exec(req.url ?? '');
    const auth = Buffer.from(String(req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
    if (req.method !== 'POST' || !m || m[1] !== TWILIO_SID || auth !== `${TWILIO_SID}:${TWILIO_TOKEN}`) return json(res, 401, { code: 20003, message: 'Authenticate' });
    if (!String(req.headers['content-type']).startsWith('application/x-www-form-urlencoded')) return json(res, 400, { message: 'form body expected' });
    const f = new URLSearchParams(body.toString());
    const to = f.get('To') ?? ''; const text = f.get('Body') ?? '';
    const code = /\b(\d{6})\b/.exec(text)?.[1];
    if (!to || !f.get('From') || !code) return json(res, 400, { code: 21602, message: 'Message body is required' });
    codes.set(to.replace(/^\+/, ''), code);
    json(res, 201, { sid: `SM${createHmac('sha256', 'x').update(to + Date.now()).digest('hex').slice(0, 32)}`, status: 'queued' });
  })().catch((e: Error) => json(res, 500, { message: e.message }));
});

// SMTP sink (no TLS, accepts any AUTH): parses what GoTrue sends, keeps the last code per recipient.
const smtp = createTcp((sock) => {
  sock.setEncoding('utf8');
  let buf = ''; let inData = false; let msg = ''; let rcpt: string[] = [];
  sock.write('220 qm-emulation ESMTP\r\n');
  const handle = (line: string) => {
    if (inData) {
      if (line === '.') {
        inData = false;
        const body = msg.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
        const code = /code is <strong>(\d{6,10})<\/strong>/.exec(body)?.[1] ?? '';
        const subject = /^Subject: (.*)$/m.exec(body)?.[1] ?? '';
        for (const r of rcpt) mails.set(r, { code, subject, count: (mails.get(r)?.count ?? 0) + 1 });
        msg = ''; rcpt = [];
        sock.write('250 OK\r\n');
      } else msg += `${line.startsWith('..') ? line.slice(1) : line}\n`;
      return;
    }
    const cmd = line.slice(0, 4).toUpperCase();
    if (cmd === 'EHLO') sock.write('250-qm-emulation\r\n250 AUTH PLAIN\r\n');
    else if (cmd === 'AUTH') sock.write('235 OK\r\n');
    else if (cmd === 'RCPT') { rcpt.push((/<([^>]+)>/.exec(line)?.[1] ?? '').toLowerCase()); sock.write('250 OK\r\n'); }
    else if (cmd === 'DATA') { inData = true; sock.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
    else if (cmd === 'QUIT') sock.end('221 Bye\r\n');
    else sock.write('250 OK\r\n');
  };
  sock.on('data', (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\r\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 2); handle(line); }
  });
  sock.on('error', () => undefined);
});

const control = createHttp((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  if (u.pathname === '/sms') return json(res, 200, { code: codes.get((u.searchParams.get('phone') ?? '').replace(/^\+/, '')) ?? null });
  if (u.pathname === '/mail') return json(res, 200, mails.get((u.searchParams.get('to') ?? '').toLowerCase()) ?? { code: null, count: 0 });
  if (u.pathname === '/templates/recovery') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(RECOVERY_TEMPLATE); }
  if (u.pathname === '/health') return json(res, 200, { ok: true });
  json(res, 404, {});
});

gateway.listen(GW_PORT, '127.0.0.1');
twilio.listen(443, '127.0.0.1');
control.listen(CTL_PORT, '127.0.0.1');
smtp.listen(SMTP_PORT, '127.0.0.1');
console.log(`gateway https://127.0.0.1:${GW_PORT}  twilio-emulation :443  control http://127.0.0.1:${CTL_PORT}  smtp :${SMTP_PORT}`);
process.on('SIGTERM', () => { gateway.close(); twilio.close(); control.close(); smtp.close(); void db.end(); process.exit(0); });
