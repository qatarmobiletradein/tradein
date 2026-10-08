/**
 * Verification of Supabase Auth access tokens.
 *
 * The API never trusts a token it has not verified itself: signature,
 * algorithm allow-list, expiry, audience and (outside development) issuer.
 * Two key sources are supported (either or both), matching Supabase's modes:
 *   - the legacy shared JWT secret (HS256);
 *   - asymmetric signing keys published at a JWKS URL (RS256 / ES256).
 */
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

export interface AccessClaims extends JWTPayload {
  sub: string;
  phone?: string;
  email?: string;
  role?: string;
  session_id?: string;
  /** Supabase Auth: how this session was established, e.g. [{ method: 'password', timestamp }]. */
  amr?: { method?: string; timestamp?: number }[];
  iat: number;
  exp: number;
}

export interface JwtVerifierOptions {
  secret?: string;
  jwksUrl?: string;
  issuer?: string;
  audience: string;
  clockToleranceS?: number;
}

export type TokenVerifier = (token: string) => Promise<AccessClaims | null>;

export function createTokenVerifier(o: JwtVerifierOptions): TokenVerifier {
  // Both may be configured during a Supabase signing-key rotation: tokens
  // signed with the new asymmetric key are checked against the JWKS, tokens
  // still signed with the legacy shared secret against the secret. The
  // token's header only SELECTS the key source; the algorithm list per
  // source is fixed, so a token cannot choose a weaker check ("alg"
  // confusion is not possible: an HS256 token is never verified with a
  // public key, and "none" is never accepted).
  const jwks: JWTVerifyGetKey | null = o.jwksUrl
    ? createRemoteJWKSet(new URL(o.jwksUrl), { cooldownDuration: 30_000, cacheMaxAge: 600_000 })
    : null;
  const secret: Uint8Array | null = o.secret ? new TextEncoder().encode(o.secret) : null;
  if (!jwks && !secret) throw new Error('No token verification key configured.');

  return async (token: string) => {
    if (!token || token.length > 8192) return null;
    try {
      const alg = decodeProtectedHeader(token).alg;
      const useSecret = alg === 'HS256';
      if (useSecret ? !secret : !jwks) return null;
      const { payload } = await jwtVerify(token, (useSecret ? secret : jwks) as never, {
        algorithms: useSecret ? ['HS256'] : ['RS256', 'ES256'],
        audience: o.audience,
        issuer: o.issuer || undefined,
        clockTolerance: o.clockToleranceS ?? 5,
        requiredClaims: ['sub', 'exp', 'iat'],
      });
      if (typeof payload.sub !== 'string' || !payload.sub) return null;
      // Only signed-in people: never the anon or service_role key, never an anonymous sign-in.
      if (payload.role !== 'authenticated') return null;
      if ((payload as { is_anonymous?: unknown }).is_anonymous === true) return null;
      return payload as AccessClaims;
    } catch {
      return null;
    }
  };
}

/** "Bearer abc" → "abc"; anything else → ''. */
export function bearerToken(header: string | undefined): string {
  if (!header) return '';
  const m = /^Bearer\s+([A-Za-z0-9._~+/-]+=*)$/.exec(header.trim());
  return m ? m[1]! : '';
}
