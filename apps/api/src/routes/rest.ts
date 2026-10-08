/**
 * Resource-style routes for the vertical slice. Each maps onto a registry
 * action, so authorisation, validation, idempotency, transactions and
 * audit are IDENTICAL to the compatibility endpoint — there is one
 * implementation of every rule, reached by two URL shapes.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { bearerToken } from '../../../../packages/auth/src/jwt.js';
import type { Deps } from '../context.js';
import { requestMeta } from '../app.js';
import { REGISTRY } from '../registry.js';
import { runAction } from '../runner.js';

type Method = 'GET' | 'POST';
interface Route { method: Method; url: string; action: string; extra?: Record<string, unknown> }

export const REST_ROUTES: Route[] = [
  // customer
  { method: 'POST', url: '/customer/estimate', action: 'customer.estimate' },
  { method: 'POST', url: '/customer/trade-ins', action: 'customer.submitTradeIn' },
  { method: 'GET', url: '/customer/trade-ins', action: 'customer.myTradeIns' },
  { method: 'GET', url: '/customer/trade-ins/:tradeInId', action: 'customer.tradeIn' },
  { method: 'POST', url: '/customer/trade-ins/:tradeInId/accept', action: 'customer.acceptOffer' },
  { method: 'POST', url: '/customer/trade-ins/:tradeInId/decline', action: 'customer.declineOffer' },
  { method: 'GET', url: '/customer/trade-ins/:tradeInId/voucher', action: 'customer.voucher' },
  // technician
  { method: 'GET', url: '/tech/queues', action: 'tech.queues' },
  { method: 'POST', url: '/tech/trade-ins/:tradeInId/inspection', action: 'tech.openInspection' },
  { method: 'POST', url: '/tech/trade-ins/:tradeInId/inspection/answers', action: 'tech.saveInspection' },
  { method: 'POST', url: '/tech/trade-ins/:tradeInId/imei-check', action: 'tech.checkImei' },
  { method: 'POST', url: '/tech/trade-ins/:tradeInId/photos', action: 'tech.uploadPhotos' },
  { method: 'GET', url: '/tech/trade-ins/:tradeInId/photos/:fileId', action: 'tech.viewPhoto' },
  { method: 'GET', url: '/tech/trade-ins/:tradeInId/summary', action: 'tech.summary' },
  { method: 'GET', url: '/tech/trade-ins/:tradeInId/offer-preview', action: 'tech.previewOffer' },
  { method: 'POST', url: '/tech/trade-ins/:tradeInId/complete', action: 'tech.complete' },
  { method: 'POST', url: '/tech/trade-ins/:tradeInId/offer', action: 'tech.submitOffer' },
  { method: 'POST', url: '/tech/trade-ins/:tradeInId/receive', action: 'tech.receiveDevice' },
  { method: 'POST', url: '/tech/trade-ins/:tradeInId/return', action: 'tech.returnDevice' },
  // partner
  { method: 'GET', url: '/vendor/queue', action: 'vendor.queue' },
  { method: 'GET', url: '/vendor/trade-ins/:tradeInId', action: 'vendor.tradeIn' },
  { method: 'POST', url: '/vendor/trade-ins/:tradeInId/voucher', action: 'vendor.issueVoucher' },
  { method: 'GET', url: '/vendor/vouchers', action: 'vendor.vouchers' },
  { method: 'POST', url: '/vendor/vouchers/:voucherId/void', action: 'vendor.voidVoucher', extra: { reissue: false } },
  { method: 'POST', url: '/vendor/vouchers/:voucherId/reissue', action: 'vendor.voidVoucher', extra: { reissue: true } },
  { method: 'GET', url: '/vendor/settlements', action: 'vendor.settlements' },
  // administrators
  { method: 'GET', url: '/admin/trade-ins', action: 'admin.tradeIns' },
  { method: 'GET', url: '/admin/trade-ins/:tradeInId', action: 'admin.tradeIn' },
  { method: 'POST', url: '/admin/trade-ins/:tradeInId/adjust-offer', action: 'admin.overridePrice' },
  { method: 'POST', url: '/admin/trade-ins/:tradeInId/override-grade', action: 'admin.overrideGrade' },
  { method: 'GET', url: '/admin/collections', action: 'admin.collections' },
  { method: 'POST', url: '/admin/collections', action: 'admin.createBatch' },
  { method: 'POST', url: '/admin/collections/:batchId/collect', action: 'admin.updateBatch', extra: { action: 'COLLECT' } },
  { method: 'POST', url: '/admin/collections/:batchId/close', action: 'admin.updateBatch', extra: { action: 'CLOSE' } },
  { method: 'POST', url: '/admin/collections/:batchId/cancel', action: 'admin.updateBatch', extra: { action: 'CANCEL' } },
  { method: 'GET', url: '/admin/settlements', action: 'admin.settlements' },
  { method: 'POST', url: '/admin/settlements', action: 'admin.createSettlement' },
  { method: 'POST', url: '/admin/settlements/:settlementId/transition', action: 'admin.advanceSettlement' },
  { method: 'POST', url: '/admin/settlements/:settlementId/cancel', action: 'admin.advanceSettlement', extra: { action: 'CANCEL' } },
  // everyone
  { method: 'GET', url: '/me', action: 'me.context' },
  { method: 'GET', url: '/notifications', action: 'notify.list' },
  { method: 'POST', url: '/notifications/:notificationId/read', action: 'notify.markRead' },
  { method: 'POST', url: '/notifications/read-all', action: 'notify.markAllRead' },
];

export function restRoutes(deps: Deps) {
  return async (app: FastifyInstance) => {
    for (const r of REST_ROUTES) {
      const handler = async (req: FastifyRequest) => {
        const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body as Record<string, unknown> : {};
        const query = (req.query && typeof req.query === 'object') ? req.query as Record<string, unknown> : {};
        // Path parameters win over body and query: the URL names the object.
        const params = { ...(r.method === 'GET' ? query : body), ...(r.extra ?? {}), ...(req.params as Record<string, unknown>) };
        const key = req.headers['idempotency-key'];
        return runAction(deps, {
          action: r.action, def: REGISTRY[r.action], accessToken: bearerToken(req.headers.authorization), rawParams: params,
          idempotencyKey: typeof key === 'string' ? key : '', meta: requestMeta(req),
        });
      };
      const opts = r.url.endsWith('/photos') ? { bodyLimit: deps.config.UPLOAD_BODY_LIMIT_BYTES } : {};
      app.route({ method: r.method, url: r.url, ...opts, handler: async (req, reply) => {
        const res = await handler(req);
        return reply.status(res.status).send(res.body);
      } });
    }
  };
}
