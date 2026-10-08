/**
 * Public, read-only endpoints a customer's browser needs before sign-in:
 * the partner list, the price-free catalogue, and the condition questions.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { customerQuestionView } from '../../../../packages/domain/src/questionnaire.js';
import { DEFAULT_ESTIMATE_NOTE } from '../../../../packages/domain/src/constants.js';
import type { Deps } from '../context.js';
import { requestMeta } from '../app.js';
import { errorResult } from '../runner.js';
import { catalogTree } from '../services/catalog.js';
import { publicVendorContext } from '../services/misc.js';

export async function publicDispatch(deps: Deps, action: string): Promise<Record<string, unknown> | null> {
  switch (action) {
    case 'public.vendorContext': return publicVendorContext(deps.pool);
    case 'public.catalogTree': return { ok: true, ...(await catalogTree(deps.pool)) };
    case 'customer.questions': {
      const r = await deps.pool.query<{ value: string }>(`select value from public.settings where key = 'customer.estimateNote'`);
      return { ok: true, questions: customerQuestionView(), note: (r.rows[0]?.value ?? '').trim() || DEFAULT_ESTIMATE_NOTE };
    }
    default: return null;
  }
}

export function publicRoutes(deps: Deps) {
  return async (app: FastifyInstance) => {
    const handle = (action: string) => async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        return reply.send(await publicDispatch(deps, action));
      } catch (err) {
        const r = errorResult(err, deps, requestMeta(req), action);
        return reply.status(r.status).send(r.body);
      }
    };
    app.get('/vendor-context', handle('public.vendorContext'));
    app.get('/catalog', handle('public.catalogTree'));
    app.get('/questions', handle('customer.questions'));
  };
}
