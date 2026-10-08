/**
 * One-time-code delivery policy (04_Auth.gs sendOtp_), applied in the
 * Supabase "Send SMS" Auth Hook.
 *
 * Supabase Auth generates, stores (hashed), expires and verifies the code;
 * that part of 3.1 (hashing, TTL, attempt limits, single-use) is now the
 * platform's. What 3.1 decided BEFORE a code went out is kept here, on the
 * server, unchanged:
 *   - fail closed with no SMS provider (generic message, audited);
 *   - a resend cooldown across BOTH purposes;
 *   - per-number hourly and daily ceilings;
 *   - platform-wide hourly and daily ceilings kept PER PURPOSE, so a flood
 *     of registrations cannot lock existing users out of signing in;
 *   - every attempt audited with a MASKED number and never the code.
 * Purpose: a number that belongs to a profile is a LOGIN; one that does
 * not is a REGISTER (3.1 issued REGISTER codes only to unknown numbers).
 */
import type pg from 'pg';
import { advisoryXactLock, withTransaction } from '../../../../packages/database/src/db.js';
import { ACTIONS } from '../../../../packages/domain/src/constants.js';
import { maskPhone, normalizePhone } from '../../../../packages/shared/src/text.js';
import type { AppConfig } from '../../../../packages/shared/src/config.js';
import type { SmsProvider } from './sms/provider.js';
import { writeAudit } from './audit.js';

export type OtpPurpose = 'LOGIN' | 'REGISTER';

export type HookOutcome =
  | { ok: true }
  | { ok: false; httpCode: number; reason: 'INVALID_PHONE' | 'UNAVAILABLE' | 'RATE_LIMITED' | 'COOLDOWN' | 'REFUSED' | 'FAILED'; message: string; retryAfterS?: number };

const audit = (db: pg.Pool | pg.PoolClient, action: string, phone: string, details: Record<string, unknown>) =>
  writeAudit(db, null, null, action, 'PHONE', maskPhone(phone), { details });

export async function purposeFor(
  db: pg.Pool | pg.PoolClient, phone: string, staffSignIn: 'password' | 'phone' | 'both' = 'phone',
): Promise<{ purpose: OtpPurpose; blocked: string | null }> {
  const s = await db.query<{ status: string }>('select status from public.app_users where phone = $1', [phone]);
  if (s.rows[0]) {
    const st = s.rows[0].status;
    // STAFF_SIGN_IN=password: no SMS code is ever sent to a staff number, even if Supabase Auth is called directly.
    if (staffSignIn === 'password') return { purpose: 'LOGIN', blocked: 'STAFF_PASSWORD_ONLY' };
    return { purpose: 'LOGIN', blocked: st === 'ACTIVE' ? null : st };
  }
  const c = await db.query<{ status: string }>('select status from public.customers where phone = $1', [phone]);
  if (c.rows[0]) return { purpose: 'LOGIN', blocked: c.rows[0].status === 'ACTIVE' ? null : c.rows[0].status };
  return { purpose: 'REGISTER', blocked: null };
}

/** Called by the Send SMS hook with the phone and the code Supabase generated. */
export async function deliverOtp(
  pool: pg.Pool, cfg: AppConfig, sms: SmsProvider, rawPhone: string, code: string,
): Promise<HookOutcome> {
  const phone = normalizePhone(rawPhone);
  if (!phone) return { ok: false, httpCode: 400, reason: 'INVALID_PHONE', message: 'Enter a valid Qatar mobile number.' };

  if (!sms.configured()) {
    await audit(pool, ACTIONS.SMS_UNAVAILABLE, phone, { environment: cfg.APP_ENV, provider: sms.name }).catch(() => undefined);
    return { ok: false, httpCode: 503, reason: 'UNAVAILABLE',
      message: 'Sign-in by text message is temporarily unavailable. Please try again later.' };
  }

  const o = cfg.otp;
  const decided = await withTransaction(pool, async (tx) => {
    // One lock for the bookkeeping, as 3.1 used one script lock: global
    // ceilings are then exact, not approximate, under concurrency.
    await advisoryXactLock(tx, 'qm.otp');
    const { purpose, blocked } = await purposeFor(tx, phone, cfg.STAFF_SIGN_IN);
    if (blocked) {
      await tx.query(`insert into public.otp_send_log (phone, purpose, channel, outcome, reason) values ($1,$2,$3,'REFUSED',$4)`,
        [phone, purpose, sms.name === 'test' ? 'TEST' : 'SMS', `account ${blocked.toLowerCase()}`]);
      return { ok: false as const, purpose, reason: 'REFUSED' as const };
    }

    const stats = (await tx.query<{
      last_at: Date | null; phone_hour: number; phone_day: number; purpose_hour: number; purpose_day: number;
    }>(
      `select
         (select max(created_at) from public.otp_send_log where phone = $1 and outcome in ('SENT','FAILED')) as last_at,
         (select count(*) from public.otp_send_log where phone = $1 and outcome in ('SENT','FAILED') and created_at > now() - interval '1 hour')::int as phone_hour,
         (select count(*) from public.otp_send_log where phone = $1 and outcome in ('SENT','FAILED') and created_at > now() - interval '24 hours')::int as phone_day,
         (select count(*) from public.otp_send_log where purpose = $2 and outcome in ('SENT','FAILED') and created_at > now() - interval '1 hour')::int as purpose_hour,
         (select count(*) from public.otp_send_log where purpose = $2 and outcome in ('SENT','FAILED') and created_at > now() - interval '24 hours')::int as purpose_day`,
      [phone, purpose])).rows[0]!;

    if (stats.last_at) {
      const waited = (Date.now() - new Date(stats.last_at).getTime()) / 1000;
      if (waited < o.cooldownS) {
        return { ok: false as const, purpose, reason: 'COOLDOWN' as const, retryAfterS: Math.ceil(o.cooldownS - waited) };
      }
    }
    const gHour = purpose === 'REGISTER' ? o.regGlobalHour : o.globalHour;
    const gDay = purpose === 'REGISTER' ? o.regGlobalDay : o.globalDay;
    let limited = '';
    if (stats.phone_hour >= o.perPhoneHour) limited = 'phone-hour';
    else if (stats.phone_day >= o.perPhoneDay) limited = 'phone-day';
    else if (stats.purpose_hour >= gHour) limited = 'global-hour';
    else if (stats.purpose_day >= gDay) limited = 'global-day';
    if (limited) {
      await tx.query(`insert into public.otp_send_log (phone, purpose, channel, outcome, reason) values ($1,$2,$3,'RATE_LIMITED',$4)`,
        [phone, purpose, sms.name === 'test' ? 'TEST' : 'SMS', limited]);
      await audit(tx, ACTIONS.OTP_RATE_LIMITED, phone, { limit: limited, purpose });
      return { ok: false as const, purpose, reason: 'RATE_LIMITED' as const };
    }
    // Reserve the send BEFORE delivery, so concurrent requests count it.
    const ins = await tx.query<{ id: number }>(
      `insert into public.otp_send_log (phone, purpose, channel, outcome) values ($1,$2,$3,'SENT') returning id`,
      [phone, purpose, sms.name === 'test' ? 'TEST' : 'SMS']);
    return { ok: true as const, purpose, logId: ins.rows[0]!.id };
  });

  if (!decided.ok) {
    if (decided.reason === 'COOLDOWN') {
      return { ok: false, httpCode: 429, reason: 'COOLDOWN', retryAfterS: decided.retryAfterS,
        message: `Please wait ${decided.retryAfterS} seconds before asking again.` };
    }
    if (decided.reason === 'REFUSED') {
      return { ok: false, httpCode: 403, reason: 'REFUSED', message: 'This account cannot sign in.' };
    }
    return { ok: false, httpCode: 429, reason: 'RATE_LIMITED', message: 'Too many code requests. Please try again later.' };
  }

  // ---- delivery happens outside the transaction (no lock held on the network) ----
  const delivery = await sms.send(phone, code, o.ttlMinutes);
  // Bookkeeping after a send is best-effort: a code the person already received must
  // never turn into an error (and a retry that sends a second SMS).
  await audit(pool, ACTIONS.OTP_SENT, phone, { purpose: decided.purpose, provider: sms.name, delivered: delivery.ok }).catch(() => undefined);
  if (!delivery.ok) {
    await pool.query(`update public.otp_send_log set outcome = 'FAILED', reason = $2 where id = $1`,
      [decided.logId, `provider ${delivery.status}`]).catch(() => undefined);
    await audit(pool, ACTIONS.OTP_SEND_FAILED, phone, { provider: sms.name, status: delivery.status }).catch(() => undefined);
    return { ok: false, httpCode: 502, reason: 'FAILED', message: 'We could not send your code right now. Please try again shortly.' };
  }
  return { ok: true };
}
