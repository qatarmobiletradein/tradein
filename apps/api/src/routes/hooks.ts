/**
 * Supabase Auth "Send SMS" hook.
 *
 * Supabase calls this with the phone number and the code it generated.
 * The request is authenticated by its Standard Webhooks signature (the
 * secret is a server environment variable), the 3.1 send policy is applied
 * (lib/otp.ts), and the code is handed to the SMS provider. The code is
 * never logged, stored or returned.
 *
 * Response protocol (verified against the open-source Supabase Auth server,
 * supabase/gotrue v2.170.0, in tests/staging/local-cloud — NOT yet against
 * Supabase Cloud):
 *   - success                → HTTP 200, empty object
 *   - a policy refusal       → HTTP 200 with { error: { http_code, message } };
 *                              Supabase Auth then answers ITS caller with that
 *                              status and message (e.g. 429 for the cooldown).
 *                              A non-2xx status here would instead become a
 *                              generic 500 "Error running hook", and 429/503
 *                              would be retried by Supabase Auth.
 *   - bad/missing signature  → HTTP 401 (never processed)
 */
import type { FastifyInstance } from 'fastify';
import type { Deps } from '../context.js';
import { deliverOtp, mfaEnrolledVia } from '../lib/otp.js';
import { verifyWebhook } from '../lib/webhooks.js';
import { resetCodeEmail } from '../lib/mail/graph.js';
import { sha256Hex } from '../../../../packages/shared/src/text.js';

/** Minutes a reset code stays valid — must equal Supabase Auth's e-mail OTP expiry. */
export const RESET_CODE_MINUTES = 15;

export function hookRoutes(deps: Deps) {
  return async (app: FastifyInstance) => {
    // The signature covers the exact bytes, so this scope keeps the raw body.
    app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 16_384 }, (_req, body, done) => done(null, body));

    // No per-IP limit here: every call comes from Supabase's servers, and a 429 would be retried.
    // Unsigned requests cost one HMAC; signed ones are bounded by the OTP limits in deliverOtp.
    app.post('/send-sms', { config: { rateLimit: false } }, async (req, reply) => {
      const secret = deps.config.SEND_SMS_HOOK_SECRET;
      const raw = typeof req.body === 'string' ? req.body : '';
      if (!secret || !verifyWebhook(secret, req.headers as Record<string, string>, raw)) {
        req.log.warn('send-sms hook: signature rejected');
        return reply.status(401).send({ error: { http_code: 401, message: 'Unauthorized' } });
      }
      let payload: { user?: { phone?: string }; sms?: { otp?: string } };
      try { payload = JSON.parse(raw); } catch { return reply.status(200).send({ error: { http_code: 400, message: 'Bad request' } }); }
      const phone = String(payload.user?.phone ?? '');
      const otp = String(payload.sms?.otp ?? '');
      if (!/^\d{4,10}$/.test(otp)) return reply.status(200).send({ error: { http_code: 400, message: 'Bad request' } });

      let r: Awaited<ReturnType<typeof deliverOtp>>;
      try {
        r = await deliverOtp(deps.pool, deps.config, deps.sms, phone, otp, mfaEnrolledVia(deps.authGateway));
      } catch (err) {
        // Database unavailable / lock timeout: still a well-formed refusal (a 5xx here would be retried
        // by Supabase Auth or turned into a generic 500).
        req.log.error({ err }, 'send-sms hook: delivery bookkeeping failed');
        return reply.status(200).send({ error: { http_code: 503, message: 'Sign-in by text message is temporarily unavailable. Please try again later.' } });
      }
      if (r.ok) return reply.status(200).send({});
      // Refusal: 200 + error object, so Supabase Auth passes OUR status and sentence to its caller.
      // A provider failure is reported as 422, not 502: Supabase Auth RETRIES a hook that answers 5xx
      // (seen on the real cloud), and the retry then met the 60 s cooldown and told the person
      // "too many code requests" instead of the truth.
      const http_code = r.reason === 'FAILED' ? 422 : r.httpCode;
      return reply.status(200).send({ error: { http_code, message: r.message } });
    });

    /*
     * Supabase Auth "Send Email" hook → Microsoft Graph (info@qatarmobile.qa).
     * Sends ONLY the staff password code, and only when the API itself asked
     * for it a moment ago (it consumes the API's RESET_EMAIL reservation for
     * that address): a direct call to Supabase's /recover cannot make it send
     * anything, so the API's per-address and platform-wide limits always hold.
     * Every other e-mail type (sign-up confirmation, magic link, e-mail change,
     * invite …) is refused — staff are created by the API, customers use SMS.
     */
    app.post('/send-email', { config: { rateLimit: false } }, async (req, reply) => {
      const refuse = (http_code: number, message: string) => reply.status(200).send({ error: { http_code, message } });
      const secret = deps.config.SEND_EMAIL_HOOK_SECRET;
      const raw = typeof req.body === 'string' ? req.body : '';
      if (!secret || !verifyWebhook(secret, req.headers as Record<string, string>, raw)) {
        req.log.warn('send-email hook: signature rejected');
        return reply.status(401).send({ error: { http_code: 401, message: 'Unauthorized' } });
      }
      let payload: { user?: { id?: string; email?: string }; email_data?: { token?: string; email_action_type?: string } };
      try { payload = JSON.parse(raw); } catch { return refuse(400, 'Bad request'); }
      const type = String(payload.email_data?.email_action_type ?? '');
      const email = String(payload.user?.email ?? '').trim().toLowerCase();
      const userId = String(payload.user?.id ?? '');
      const code = String(payload.email_data?.token ?? '');
      if (type !== 'recovery') {
        req.log.warn({ type }, 'send-email hook: e-mail type not sent');
        return refuse(403, 'This e-mail is not sent by Qatar Mobile Trade-In.');
      }
      if (!/^\d{6}$/.test(code) || !email) return refuse(400, 'Bad request');
      if (!deps.mailer?.configured()) return refuse(503, 'E-mail is temporarily unavailable. Please try again later.');
      try {
        const staff = (await deps.pool.query(
          `select 1 from public.app_users where status = 'ACTIVE' and auth_user_id = $1::uuid and lower(btrim(email)) = $2`, [userId, email])).rowCount;
        if (!staff) return refuse(403, 'This e-mail is not sent by Qatar Mobile Trade-In.');
        const slot = (await deps.pool.query<{ id: string }>(
          `update public.staff_auth_attempts set succeeded = true
            where id = (select id from public.staff_auth_attempts
                         where email_key = $1 and kind = 'RESET_EMAIL' and not succeeded and created_at > now() - interval '2 minutes'
                         order by created_at desc limit 1)
            returning id`, [sha256Hex(email)])).rows[0];
        if (!slot) {
          req.log.warn('send-email hook: no pending API request for this address');
          return refuse(429, 'Please request the code from the Qatar Mobile Trade-In sign-in page.');
        }
        const m = resetCodeEmail(code, RESET_CODE_MINUTES);
        const sent = await deps.mailer.send(email, m.subject, m.html, m.text);
        if (!sent.ok) {
          req.log.error({ status: sent.status, code: sent.code }, 'send-email hook: Graph refused');
          return refuse(503, 'E-mail is temporarily unavailable. Please try again later.');
        }
        return reply.status(200).send({});
      } catch (err) {
        req.log.error({ err }, 'send-email hook: failed');
        return refuse(503, 'E-mail is temporarily unavailable. Please try again later.');
      }
    });
  };
}
