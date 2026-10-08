/**
 * Standard Webhooks signature verification (used by Supabase Auth Hooks).
 *
 *   signed content  = `${webhook-id}.${webhook-timestamp}.${rawBody}`
 *   signature       = base64(HMAC-SHA256(secret, signed content))
 *   header          = "v1,<sig> v1,<sig2>" (space-separated, any may match)
 *   secret          = "v1,whsec_<base64>" or "whsec_<base64>"
 *
 * [platform] The header names and secret format above follow the Standard
 * Webhooks specification that Supabase documents for Auth Hooks. Confirm
 * against the project's dashboard when configuring the hook (see
 * docs/SUPABASE_SETUP.md); the end-to-end path is NOT EXECUTED here.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export function decodeWebhookSecret(secret: string): Buffer {
  let s = secret.trim();
  if (s.startsWith('v1,')) s = s.slice(3);
  if (s.startsWith('whsec_')) s = s.slice(6);
  return Buffer.from(s, 'base64');
}

export function signWebhook(secret: string, id: string, timestamp: string, body: string): string {
  const mac = createHmac('sha256', decodeWebhookSecret(secret)).update(`${id}.${timestamp}.${body}`).digest('base64');
  return `v1,${mac}`;
}

export function verifyWebhook(
  secret: string, headers: Record<string, string | string[] | undefined>, rawBody: string,
  nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = 300,
): boolean {
  const h = (k: string): string => {
    const v = headers[k];
    return Array.isArray(v) ? v[0] ?? '' : v ?? '';
  };
  const id = h('webhook-id');
  const ts = h('webhook-timestamp');
  const sigHeader = h('webhook-signature');
  if (!id || !ts || !sigHeader) return false;
  const t = Number(ts);
  if (!Number.isInteger(t) || Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = Buffer.from(signWebhook(secret, id, ts, rawBody).slice(3), 'base64');
  for (const part of sigHeader.split(' ')) {
    const [version, sig] = part.split(',', 2);
    if (version !== 'v1' || !sig) continue;
    const given = Buffer.from(sig, 'base64');
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}
