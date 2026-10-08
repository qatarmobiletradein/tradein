/**
 * The token rules every endpoint applies (one place, so no route can forget one):
 * staff sign-in method, live Supabase session, and the authenticator-app step
 * for the roles in STAFF_MFA_ROLES.
 */
import type { AppConfig } from '../../../../packages/shared/src/config.js';
import type { ResolveOptions } from '../../../../packages/auth/src/principal.js';

export function authOptions(c: AppConfig, o: { allowLink: boolean; allowPendingMfa?: boolean; staffSignIn?: 'password' | 'phone' | 'both' }): ResolveOptions {
  return { staffSignIn: c.STAFF_SIGN_IN, checkSession: c.AUTH_SESSION_CHECK, mfaRoles: c.STAFF_MFA_ROLES, ...o };
}
