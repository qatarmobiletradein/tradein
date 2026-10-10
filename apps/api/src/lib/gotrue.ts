/**
 * The API's calls to Supabase Auth (GoTrue) on the user's behalf.
 *
 * The browser never talks to Supabase Auth directly for sign-in: Railway
 * runs the 3.1 pre-checks (unknown number, pending, rejected, disabled)
 * first and only then asks Supabase to send a code. The code itself is
 * delivered by the Send SMS hook (routes/hooks.ts → lib/otp.ts).
 *
 * [platform] Endpoint paths and payloads below follow the public GoTrue
 * REST API (/auth/v1/otp, /verify, /token, /logout, /recover, /user and the
 * admin /admin/users endpoints). Admin calls use the SERVER secret key.
 * They are exercised in tests against a local stub, NOT against a live
 * Supabase project — see docs/TEST_RESULTS.md.
 */
/** Legacy Supabase keys are JWTs; new ones start with sb_publishable_ / sb_secret_. */
export const isLegacyJwtKey = (k: string): boolean => /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(k);

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  userId: string;
}

export type GatewayError = { ok: false; status: number; code: string };

/** phone: Supabase's form (E.164 digits, no "+"), '' when the user has none. */
export interface AuthUserInfo { id: string; email: string | null; emailConfirmed: boolean; phone?: string;
  /** admin lookups only: the user has at least one VERIFIED authenticator-app factor */
  mfaVerified?: boolean }

export interface AuthGateway {
  // clientIp: the end user's IP, forwarded to Supabase Auth's per-IP rate limits when enabled (see GoTrueGateway).
  sendOtp(phoneE164: string, createUser: boolean, clientIp?: string): Promise<{ ok: true } | GatewayError>;
  verifyOtp(phoneE164: string, code: string, clientIp?: string): Promise<({ ok: true } & AuthSession) | GatewayError>;
  refresh(refreshToken: string, clientIp?: string): Promise<({ ok: true } & AuthSession) | GatewayError>;
  logout(accessToken: string, scope: 'local' | 'global' | 'others'): Promise<{ ok: boolean }>;

  /* ---- staff email + password (STAFF_SIGN_IN=password) ---- */
  passwordLogin(email: string, password: string, clientIp?: string): Promise<({ ok: true } & AuthSession) | GatewayError>;
  /** Supabase Auth e-mails a reset code (the "Reset password" template must contain {{ .Token }}). */
  sendRecovery(email: string, clientIp?: string): Promise<{ ok: true } | GatewayError>;
  verifyRecovery(email: string, code: string, clientIp?: string): Promise<({ ok: true } & AuthSession) | GatewayError>;
  setPassword(accessToken: string, password: string): Promise<{ ok: true } | GatewayError>;
  /* ---- admin (server secret key; never reachable from a browser) ---- */
  adminGetUser(id: string): Promise<({ ok: true } & AuthUserInfo) | GatewayError>;
  adminCreateUser(email: string, password: string): Promise<({ ok: true } & AuthUserInfo) | GatewayError>;
  adminUpdateUser(id: string, email: string, password: string): Promise<{ ok: true } | GatewayError>;
  adminDeleteUser(id: string): Promise<{ ok: true } | GatewayError>;
  /** STAFF_SIGN_IN=both: put the profile's mobile number (confirmed) on its Auth user, so a phone code reaches the same user. */
  adminSetPhone(id: string, phoneE164: string): Promise<{ ok: true } | GatewayError>;

  /* ---- authenticator app (TOTP) — all with the user's own access token ---- */
  mfaFactors(accessToken: string): Promise<({ ok: true; factors: MfaFactor[] }) | GatewayError>;
  mfaEnroll(accessToken: string, issuer: string, friendlyName: string): Promise<({ ok: true } & MfaEnrollment) | GatewayError>;
  /** Challenge + verify in one step; returns the upgraded (aal2) session. */
  mfaVerify(accessToken: string, factorId: string, code: string): Promise<({ ok: true } & AuthSession) | GatewayError>;
}

export interface MfaFactor { id: string; type: string; status: 'verified' | 'unverified' | string; friendlyName: string }
export interface MfaEnrollment { factorId: string; qrCode: string; secret: string; uri: string }

type Json = Record<string, unknown>;

/** Only an IP literal may go into a header (no header injection, no host names). */
const IP_RE = /^[0-9a-fA-F:.]{2,45}$/;

export class GoTrueGateway implements AuthGateway {
  constructor(
    private readonly url: string, private readonly anonKey: string, private readonly fetchImpl: typeof fetch = fetch,
    /** SECRET (sb_secret_... or legacy service_role JWT). For the admin calls below, and for IP forwarding. */
    private readonly serviceKey?: string,
    /**
     * Every call reaches Supabase Auth from the API's own IP, so Supabase's PER-IP limits (e.g. 30 code
     * verifications per 5 minutes) would be shared by all users. Supabase documents a fix: send the end
     * user's IP in `Sb-Forwarded-For` with a NEW-style secret key (sb_secret_…; legacy keys are not
     * supported) and switch IP forwarding on in the project (Auth → Rate Limits). Opt-in
     * (SUPABASE_AUTH_FORWARD_CLIENT_IP) because it is not verified against Supabase Cloud yet.
     */
    private readonly forwardClientIp = false,
  ) {}

  private async call(path: string, body: Json | null, bearer?: string, o: { method?: string; admin?: boolean; clientIp?: string } = {}): Promise<{ status: number; json: Json }> {
    const forward = !o.admin && !bearer && this.forwardClientIp && !!this.serviceKey && this.serviceKey.startsWith('sb_secret_')
      && !!o.clientIp && IP_RE.test(o.clientIp);
    const key = o.admin || forward ? this.serviceKey : this.anonKey;
    if (!key) return { status: 503, json: { error_code: 'auth_admin_unconfigured' } };
    const headers: Record<string, string> = { apikey: key, 'Content-Type': 'application/json' };
    if (forward) headers['Sb-Forwarded-For'] = o.clientIp!;
    // New-style keys (sb_publishable_ / sb_secret_) are not JWTs and go ONLY in `apikey`;
    // a legacy JWT key may also be sent as the bearer. A user token is always the bearer.
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    else if (isLegacyJwtKey(key)) headers.Authorization = `Bearer ${key}`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.url.replace(/\/$/, '')}/auth/v1${path}`, {
        method: o.method ?? 'POST', headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // Network/TLS failure or timeout reaching Supabase Auth: a clear "unavailable", never a 500.
      return { status: 503, json: { error_code: 'auth_unreachable' } };
    }
    let json: Json = {};
    try { json = (await res.json()) as Json; } catch { json = {}; }
    return { status: res.status, json };
  }

  private static err(status: number, json: Json): GatewayError {
    const code = String(json.error_code ?? json.code ?? json.error ?? 'unknown');
    return { ok: false, status, code };
  }

  /** A 200 that is not a session (unreadable body) is Supabase misbehaving, never "wrong password". */
  private static sessionOrErr(r: { status: number; json: Json }): ({ ok: true } & AuthSession) | GatewayError {
    if (r.status !== 200) return GoTrueGateway.err(r.status, r.json);
    const s = GoTrueGateway.session(r.json);
    return s ? { ok: true as const, ...s } : { ok: false, status: 502, code: 'auth_bad_response' };
  }

  private static session(json: Json): AuthSession | null {
    const at = json.access_token; const rt = json.refresh_token;
    const user = json.user as Json | undefined;
    if (typeof at !== 'string' || typeof rt !== 'string') return null;
    return { accessToken: at, refreshToken: rt, expiresIn: Number(json.expires_in) || 3600, userId: String(user?.id ?? '') };
  }

  async sendOtp(phone: string, createUser: boolean, clientIp?: string) {
    const r = await this.call('/otp', { phone: phone.replace(/^\+/, ''), create_user: createUser, channel: 'sms' }, undefined, { clientIp });
    return r.status >= 200 && r.status < 300 ? { ok: true as const } : GoTrueGateway.err(r.status, r.json);
  }

  async verifyOtp(phone: string, code: string, clientIp?: string) {
    return GoTrueGateway.sessionOrErr(await this.call('/verify', { type: 'sms', phone: phone.replace(/^\+/, ''), token: code }, undefined, { clientIp }));
  }

  async refresh(refreshToken: string, clientIp?: string) {
    return GoTrueGateway.sessionOrErr(await this.call('/token?grant_type=refresh_token', { refresh_token: refreshToken }, undefined, { clientIp }));
  }

  async logout(accessToken: string, scope: 'local' | 'global' | 'others') {
    const r = await this.call(`/logout?scope=${scope}`, null, accessToken);
    return { ok: r.status >= 200 && r.status < 300 };
  }

  async mfaFactors(accessToken: string) {
    const r = await this.call('/user', null, accessToken, { method: 'GET' });
    if (r.status !== 200) return GoTrueGateway.err(r.status, r.json);
    const raw = Array.isArray(r.json.factors) ? (r.json.factors as Json[]) : [];
    const factors = raw.map((f) => ({ id: String(f.id ?? ''), type: String(f.factor_type ?? ''), status: String(f.status ?? ''), friendlyName: String(f.friendly_name ?? '') }))
      .filter((f) => f.id && f.type === 'totp');
    return { ok: true as const, factors };
  }

  async mfaEnroll(accessToken: string, issuer: string, friendlyName: string) {
    const r = await this.call('/factors', { factor_type: 'totp', issuer, friendly_name: friendlyName }, accessToken);
    if (r.status !== 200) return GoTrueGateway.err(r.status, r.json);
    const totp = (r.json.totp ?? {}) as Json;
    if (typeof r.json.id !== 'string' || typeof totp.secret !== 'string') return { ok: false as const, status: 502, code: 'auth_bad_response' };
    return { ok: true as const, factorId: r.json.id, qrCode: String(totp.qr_code ?? ''), secret: totp.secret, uri: String(totp.uri ?? '') };
  }

  async mfaVerify(accessToken: string, factorId: string, code: string) {
    const fid = encodeURIComponent(factorId);
    const c = await this.call(`/factors/${fid}/challenge`, {}, accessToken);
    if (c.status !== 200 || typeof c.json.id !== 'string') return GoTrueGateway.err(c.status === 200 ? 502 : c.status, c.json);
    return GoTrueGateway.sessionOrErr(await this.call(`/factors/${fid}/verify`, { challenge_id: c.json.id, code }, accessToken));
  }

  private static okOrErr(r: { status: number; json: Json }) {
    return r.status >= 200 && r.status < 300 ? { ok: true as const } : GoTrueGateway.err(r.status, r.json);
  }
  private static user(json: Json): AuthUserInfo | null {
    if (typeof json.id !== 'string') return null;
    return { id: json.id, email: typeof json.email === 'string' && json.email ? json.email : null, emailConfirmed: !!json.email_confirmed_at,
      phone: typeof json.phone === 'string' ? json.phone : '',
      mfaVerified: Array.isArray(json.factors) && (json.factors as Json[]).some((f) => f && f.status === 'verified') };
  }

  async passwordLogin(email: string, password: string, clientIp?: string) {
    return GoTrueGateway.sessionOrErr(await this.call('/token?grant_type=password', { email, password }, undefined, { clientIp }));
  }

  async sendRecovery(email: string, clientIp?: string) {
    return GoTrueGateway.okOrErr(await this.call('/recover', { email }, undefined, { clientIp }));
  }

  async verifyRecovery(email: string, code: string, clientIp?: string) {
    return GoTrueGateway.sessionOrErr(await this.call('/verify', { type: 'recovery', email, token: code }, undefined, { clientIp }));
  }

  async setPassword(accessToken: string, password: string) {
    return GoTrueGateway.okOrErr(await this.call('/user', { password }, accessToken, { method: 'PUT' }));
  }

  async adminGetUser(id: string) {
    const r = await this.call(`/admin/users/${encodeURIComponent(id)}`, null, undefined, { method: 'GET', admin: true });
    const u = r.status === 200 ? GoTrueGateway.user(r.json) : null;
    return u ? { ok: true as const, ...u } : GoTrueGateway.err(r.status, r.json);
  }

  async adminCreateUser(email: string, password: string) {
    // app_metadata (only the secret key can set it) marks Auth users this API manages, so the stray
    // clean-up never touches an Auth user it did not create.
    const r = await this.call('/admin/users', { email, password, email_confirm: true, app_metadata: { qm_staff: true } }, undefined, { admin: true });
    const u = r.status >= 200 && r.status < 300 ? GoTrueGateway.user(r.json) : null;
    return u ? { ok: true as const, ...u } : GoTrueGateway.err(r.status, r.json);
  }

  async adminUpdateUser(id: string, email: string, password: string) {
    return GoTrueGateway.okOrErr(await this.call(`/admin/users/${encodeURIComponent(id)}`,
      { email, password, email_confirm: true, app_metadata: { qm_staff: true } }, undefined, { method: 'PUT', admin: true }));
  }

  async adminDeleteUser(id: string) {
    return GoTrueGateway.okOrErr(await this.call(`/admin/users/${encodeURIComponent(id)}`, null, undefined, { method: 'DELETE', admin: true }));
  }

  async adminSetPhone(id: string, phone: string) {
    return GoTrueGateway.okOrErr(await this.call(`/admin/users/${encodeURIComponent(id)}`,
      { phone: phone.replace(/^\+/, ''), phone_confirm: true }, undefined, { method: 'PUT', admin: true }));
  }
}

/** Used when SUPABASE_URL is not configured (local development without Auth). */
const UNAVAILABLE = { ok: false as const, status: 503, code: 'auth_unavailable' };
export class UnavailableGateway implements AuthGateway {
  async sendOtp() { return UNAVAILABLE; }
  async verifyOtp() { return UNAVAILABLE; }
  async refresh() { return UNAVAILABLE; }
  async logout() { return { ok: false }; }
  async passwordLogin() { return UNAVAILABLE; }
  async sendRecovery() { return UNAVAILABLE; }
  async verifyRecovery() { return UNAVAILABLE; }
  async setPassword() { return UNAVAILABLE; }
  async adminGetUser() { return UNAVAILABLE; }
  async adminCreateUser() { return UNAVAILABLE; }
  async adminUpdateUser() { return UNAVAILABLE; }
  async adminDeleteUser() { return UNAVAILABLE; }
  async adminSetPhone() { return UNAVAILABLE; }
  async mfaFactors() { return UNAVAILABLE; }
  async mfaEnroll() { return UNAVAILABLE; }
  async mfaVerify() { return UNAVAILABLE; }
}
