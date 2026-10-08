/**
 * Errors that are allowed to reach a caller.
 *
 * 3.1 answered every refusal with { ok: false, message } and kept stack
 * traces, sheet names and internals in the server log (06_RBAC.gs,
 * friendlyError_). The same contract holds here: an AppError carries a
 * sentence written for a person; anything else becomes a generic line.
 */

export type ErrorCode =
  | 'VALIDATION'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'BUSINESS_RULE'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'INTERNAL';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  BUSINESS_RULE: 422,
  IDEMPOTENCY_KEY_REUSED: 409,
  IDEMPOTENCY_KEY_REQUIRED: 428,
  RATE_LIMITED: 429,
  UNAVAILABLE: 503,
  INTERNAL: 500,
};

export const GENERIC_MESSAGE = 'Something went wrong. Please try again.';
export const PERMISSION_MESSAGE = 'You do not have permission to do that.';
export const SESSION_ENDED_MESSAGE = 'Your session has ended. Please sign in again.';
export const BUSY_MESSAGE = 'The system is busy. Please try again in a moment.';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Extra fields that are SAFE to return (e.g. { reauth: true }). */
  readonly extra: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.extra = extra;
  }
}

/** A business refusal — the 3.1 fail_('...') equivalent. */
export const fail = (message: string, extra: Record<string, unknown> = {}): AppError =>
  new AppError('BUSINESS_RULE', message, extra);

export const notFound = (message: string): AppError => new AppError('NOT_FOUND', message);
export const forbidden = (message = PERMISSION_MESSAGE): AppError => new AppError('FORBIDDEN', message);
export const invalid = (message: string, extra: Record<string, unknown> = {}): AppError =>
  new AppError('VALIDATION', message, extra);
export const unauthenticated = (): AppError =>
  new AppError('UNAUTHENTICATED', SESSION_ENDED_MESSAGE, { reauth: true });

/**
 * A refusal raised AFTER work that must still be committed — see
 * services/inspections.ts (tech.submitOffer): 3.1 completed the inspection
 * in one locked step and refused the offer in a second, so the inspection
 * stayed completed. The transaction wrapper commits and then answers with
 * the inner error; the idempotency record is NOT written (3.1 stored only
 * successes).
 */
export class CommitThenFail extends Error {
  readonly inner: AppError;
  constructor(inner: AppError) {
    super(inner.message);
    this.name = 'CommitThenFail';
    this.inner = inner;
  }
}

/** PostgreSQL error → AppError, for the constraint/trigger hints the schema raises. */
export function fromPgError(err: unknown): AppError | null {
  const e = err as { code?: string; hint?: string; constraint?: string } | null;
  if (!e || typeof e !== 'object' || typeof e.code !== 'string') return null;

  switch (e.hint) {
    case 'QM_INVALID_TRANSITION':
      return fail('That change is not allowed from the record\'s current state.');
    case 'QM_VALUE_FROZEN':
      return fail('A voucher has been issued for this trade-in, so its value cannot change.');
    case 'QM_SETTLEMENT_LOCKED':
      return fail('This settlement is approved or paid and cannot be changed.');
    case 'QM_NOT_SETTLEABLE':
      return fail('Only collected trade-ins can be settled.');
    case 'QM_LAST_SUPER_ADMIN':
      return fail('This is the last active super administrator. Appoint another one first, ' +
                  'otherwise nobody could recover the system.');
    case 'QM_VOUCHER_VOIDED':
      return fail('That voucher is not active.');
    case 'QM_VOUCHER_IMMUTABLE':
      return fail('A voucher is a printed document; its figures cannot change.');
    case 'QM_AUDIT_APPEND_ONLY':
      return new AppError('INTERNAL', GENERIC_MESSAGE);
    default:
      break;
  }

  if (e.code === '23505') {
    switch (e.constraint) {
      case 'trade_ins_open_imei_key':
        return fail('There is already an open trade-in for this device.');
      case 'vouchers_one_live_per_tradein':
        return fail('A voucher has already been issued for this trade-in.');
      case 'collection_items_one_pending':
        return fail('That device is already on an open collection note.');
      case 'app_users_phone_key':
      case 'customers_phone_key':
        return fail('An account already exists for this number.', { needsLogin: true });
      case 'app_users_email_key':
        return fail('That email address is already used by another staff account.');
      default:
        return new AppError('CONFLICT', 'That record already exists.');
    }
  }
  if (e.code === '40001' || e.code === '40P01' || e.code === '55P03') {
    return new AppError('UNAVAILABLE', BUSY_MESSAGE);
  }
  if (e.code === '23503' || e.code === '23514') {
    return fail('That change would leave the records inconsistent, so it was refused.');
  }
  return null;
}
