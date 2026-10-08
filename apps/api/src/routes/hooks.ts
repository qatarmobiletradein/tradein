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
import { deliverOtp } from '../lib/otp.js';
import { verifyWebhook } from '../lib/webhooks.js';

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
        r = await deliverOtp(deps.pool, deps.config, deps.sms, phone, otp);
      } catch (err) {
        // Database unavailable / lock timeout: still a well-formed refusal (a 5xx here would be retried
        // by Supabase Auth or turned into a generic 500).
        req.log.error({ err }, 'send-sms hook: delivery bookkeeping failed');
        return reply.status(200).send({ error: { http_code: 503, message: 'Sign-in by text message is temporarily unavailable. Please try again later.' } });
      }
      if (r.ok) return reply.status(200).send({});
      // Refusal: 200 + error object, so Supabase Auth passes OUR status and sentence to its caller.
      return reply.status(200).send({ error: { http_code: r.httpCode, message: r.message } });
    });
  };
}
