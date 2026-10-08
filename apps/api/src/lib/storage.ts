/**
 * Supabase Storage, server side only (service-role credentials never leave
 * Railway).
 *
 *   catalog-media      PUBLIC   logos and product photos; public URLs.
 *   inspection-photos  PRIVATE  device evidence; short-lived signed URLs,
 *                               issued only after the same scope check
 *                               3.1 applied in viewInspectionPhoto_.
 *
 * Every upload is validated by its BYTES (magic numbers), not by the
 * declared type or file name, and by size. SVG is never accepted.
 *
 * [platform] Paths follow the Storage REST API (/storage/v1/object/...,
 * /storage/v1/object/sign/...). Exercised against an in-memory fake in
 * tests; NOT EXECUTED against a live bucket.
 */
import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../../../../packages/shared/src/errors.js';
import { isLegacyJwtKey } from './gotrue.js';

export type Bucket = 'catalog-media' | 'inspection-photos';

export interface StorageClient {
  upload(bucket: Bucket, path: string, bytes: Buffer, contentType: string): Promise<void>;
  signedUrl(bucket: 'inspection-photos', path: string, ttlSeconds: number): Promise<string>;
  publicUrl(bucket: 'catalog-media', path: string): string;
  remove(bucket: Bucket, path: string): Promise<void>;
}

/** Magic-number sniffing for the raster types 3.1 allowed. */
export function sniffImageMime(b: Buffer): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 6).toString('ascii') === 'GIF87a' || b.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = b.subarray(8, 12).toString('ascii');
    if (['heic', 'heix', 'hevc', 'hevx'].includes(brand)) return 'image/heic';
    if (['mif1', 'msf1', 'heif'].includes(brand)) return 'image/heif';
  }
  return null;
}

const EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/bmp': 'bmp', 'image/heic': 'heic', 'image/heif': 'heif',
};

export interface ValidatedImage { bytes: Buffer; mime: string; ext: string; sha256: string; size: number }

/**
 * Decode a data URL or bare base64 string and validate it.
 * The declared MIME type, if any, must agree with the bytes.
 */
export function validateImage(input: unknown, maxBytes: number): ValidatedImage {
  const s = typeof input === 'string' ? input.trim() : '';
  if (!s) throw new AppError('VALIDATION', 'Choose an image to upload.');
  let declared = '';
  let b64 = s;
  const m = /^data:([a-z0-9.+/-]+);base64,(.*)$/is.exec(s);
  if (m) { declared = m[1]!.toLowerCase(); b64 = m[2]!; }
  if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw new AppError('VALIDATION', 'That file could not be read.');
  // Size check BEFORE decoding fully: base64 is 4/3 of the payload.
  if (Math.floor((b64.replace(/\s/g, '').length * 3) / 4) > maxBytes + 4) {
    throw new AppError('VALIDATION', `That image is larger than ${Math.round(maxBytes / 1048576)} MB.`);
  }
  const bytes = Buffer.from(b64, 'base64');
  if (!bytes.length) throw new AppError('VALIDATION', 'That file is empty.');
  if (bytes.length > maxBytes) throw new AppError('VALIDATION', `That image is larger than ${Math.round(maxBytes / 1048576)} MB.`);
  const mime = sniffImageMime(bytes);
  if (!mime) throw new AppError('VALIDATION', 'Only PNG, JPEG, GIF, WebP, HEIC or BMP images are accepted.');
  const norm = declared === 'image/jpg' ? 'image/jpeg' : declared;
  if (norm && norm !== mime && !(norm.startsWith('image/hei') && mime.startsWith('image/hei'))) {
    throw new AppError('VALIDATION', 'The file type does not match its contents.');
  }
  return { bytes, mime, ext: EXT[mime]!, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
}

export const objectName = (prefix: string, ext: string): string => `${prefix}/${randomUUID()}.${ext}`;

export class SupabaseStorage implements StorageClient {
  private readonly url: string;
  constructor(url: string, private readonly serviceKey: string, private readonly fetchImpl: typeof fetch = fetch) {
    this.url = url.replace(/\/+$/, '');
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    // New-style secret keys (sb_secret_...) are not JWTs: `apikey` only. Legacy service_role JWTs: both headers.
    return isLegacyJwtKey(this.serviceKey)
      ? { apikey: this.serviceKey, Authorization: `Bearer ${this.serviceKey}`, ...extra }
      : { apikey: this.serviceKey, ...extra };
  }

  private enc(path: string): string {
    return path.split('/').map(encodeURIComponent).join('/');
  }

  async upload(bucket: Bucket, path: string, bytes: Buffer, contentType: string): Promise<void> {
    const res = await this.fetchImpl(`${this.url}/storage/v1/object/${bucket}/${this.enc(path)}`, {
      method: 'POST', headers: this.headers({ 'Content-Type': contentType, 'x-upsert': 'false', 'cache-control': '3600' }),
      body: bytes, redirect: 'manual', signal: AbortSignal.timeout(30_000),
    }).catch(() => { throw new AppError('UNAVAILABLE', 'The file could not be stored. Please try again.'); });
    if (res.status < 200 || res.status >= 300) throw new AppError('UNAVAILABLE', 'The file could not be stored. Please try again.');
  }

  async signedUrl(bucket: 'inspection-photos', path: string, ttlSeconds: number): Promise<string> {
    const res = await this.fetchImpl(`${this.url}/storage/v1/object/sign/${bucket}/${this.enc(path)}`, {
      method: 'POST', headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ expiresIn: ttlSeconds }), redirect: 'manual', signal: AbortSignal.timeout(10_000),
    }).catch(() => { throw new AppError('UNAVAILABLE', 'The photo could not be opened. Please try again.'); });
    const j = (await res.json().catch(() => ({}))) as { signedURL?: string; signedUrl?: string };
    const rel = j.signedURL ?? j.signedUrl;
    if (res.status !== 200 || !rel) throw new AppError('UNAVAILABLE', 'The photo could not be opened. Please try again.');
    return rel.startsWith('http') ? rel : `${this.url}/storage/v1${rel}`;
  }

  publicUrl(bucket: 'catalog-media', path: string): string {
    return `${this.url}/storage/v1/object/public/${bucket}/${this.enc(path)}`;
  }

  async remove(bucket: Bucket, path: string): Promise<void> {
    await this.fetchImpl(`${this.url}/storage/v1/object/${bucket}`, {
      method: 'DELETE', headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ prefixes: [path] }), redirect: 'manual', signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
  }
}

/** In-memory storage for tests and for development without Supabase. Never used in production. */
export class MemoryStorage implements StorageClient {
  readonly objects = new Map<string, { bytes: Buffer; contentType: string }>();
  async upload(bucket: Bucket, path: string, bytes: Buffer, contentType: string): Promise<void> {
    const k = `${bucket}/${path}`;
    if (this.objects.has(k)) throw new AppError('CONFLICT', 'That file already exists.');
    this.objects.set(k, { bytes, contentType });
  }
  async signedUrl(bucket: 'inspection-photos', path: string, ttl: number): Promise<string> {
    return `memory://${bucket}/${path}?expires=${Math.floor(Date.now() / 1000) + ttl}&token=test`;
  }
  publicUrl(bucket: 'catalog-media', path: string): string { return `memory://${bucket}/${path}`; }
  async remove(bucket: Bucket, path: string): Promise<void> { this.objects.delete(`${bucket}/${path}`); }
}
