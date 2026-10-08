/**
 * Per-request context handed to every service function.
 */
import type { Mailer } from './lib/mail/graph.js';
import type pg from 'pg';
import type { AuthzCtx, Denial, Principal } from '../../../packages/auth/src/index.js';
import type { Tx } from '../../../packages/database/src/db.js';
import type { AppConfig, Logger } from '../../../packages/shared/src/index.js';
import type { SmsProvider } from './lib/sms/provider.js';
import type { StorageClient } from './lib/storage.js';
import type { AuthGateway } from './lib/gotrue.js';
import type { TokenVerifier } from '../../../packages/auth/src/jwt.js';

export interface Deps {
  config: AppConfig;
  pool: pg.Pool;
  log: Logger;
  sms: SmsProvider;
  storage: StorageClient;
  authGateway: AuthGateway;
  verifyToken: TokenVerifier;
  /** Staff reset e-mail sender (Microsoft Graph). Absent = not configured. */
  mailer?: Mailer;
}

export interface RequestMeta {
  requestId: string;
  ip: string;
  userAgent: string;
}

export interface Ctx extends AuthzCtx {
  p: Principal;
  db: Tx;
  denials: Denial[];
  meta: RequestMeta;
  deps: Deps;
  /** The registry action being run (e.g. 'vendor.issueVoucher'). */
  action: string;
  /** Idempotency record id when the request carried a key, else ''. Written onto created rows. */
  operationId: string;
  /** Raw (pre-validation) params, for "a forbidden field was sent" audits. */
  rawParams: Record<string, unknown>;
}

/** A context for system jobs (reconciliation), acting as no person. */
export const SYSTEM_PRINCIPAL: Principal = {
  principalType: 'STAFF', principalId: 'system', authUserId: '', phone: '', name: 'system',
  role: 'SUPER_ADMIN', vendorId: '', branchId: '', isPlatform: true, isVendorScoped: false,
};
