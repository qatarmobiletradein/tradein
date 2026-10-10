/**
 * IMEI entry (2026-10-10): the browser component's pure core (apps/web/qm-imei.js) and the shared
 * server-side normaliser. The API is authoritative; these are the same rules on both sides.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { isValidImei, normalizeImei } from '../../packages/shared/src/text.js';

const SRC = readFileSync('apps/web/qm-imei.js', 'utf8');
const ctx: Record<string, unknown> = {};
runInNewContext(SRC, ctx);
const core = ctx.QMImeiCore as {
  luhn(d: string): boolean; normalize(r: unknown): string | null; check(r: unknown): string;
  extract(p: unknown): { valid: { imei: string; label: string }[]; rejected: number }; format(d: string): string;
};

describe('IMEI validation (frontend core = backend rules)', () => {
  it('accepts a valid 15-digit IMEI, also typed in the printed 2-6-6-1 grouping', () => {
    expect(core.check('490154203237518')).toBe('valid');
    expect(core.check(' 49 015420 323751 8 ')).toBe('valid');
    expect(core.check('49-015420-323751-8')).toBe('valid');
    expect(normalizeImei('49 015420 323751 8')).toBe('490154203237518');
    expect(isValidImei('490154203237518')).toBe(true);
  });
  it('refuses a wrong check digit, too short, too long, letters and symbols', () => {
    expect(core.check('490154203237519')).toBe('checksum');
    expect(isValidImei('490154203237519')).toBe(false);
    expect(core.check('49015420323751')).toBe('short');
    expect(core.check('4901542032375180')).toBe('long');
    expect(core.check('49015420323751A')).toBe('malformed');
    expect(core.check('4901542032.37518')).toBe('malformed');
    expect(core.check('')).toBe('empty');
    expect(normalizeImei('49015420323751A')).toBeNull();
    expect(normalizeImei('IMEI 490154203237518')).toBeNull();
    // The frontend and the backend agree on every case.
    for (const v of ['490154203237518', '490154203237519', '4901542032375', '49015420323751A', '35 693803 564380 9']) {
      const n = normalizeImei(v);
      expect([v, core.check(v) === 'valid']).toEqual([v, n !== null && isValidImei(n)]);
    }
  });
});

describe('IMEI extraction from a scanned barcode payload', () => {
  it('a bare barcode value', () => {
    expect(core.extract('356938035643809').valid).toEqual([{ imei: '356938035643809', label: '' }]);
  });
  it('an IMEI inside other text; the rest of the payload is ignored', () => {
    const r = core.extract('Model A2848 IMEI: 356938035643809 S/N F2LXK1234 EAN 0194253401234');
    expect(r.valid.map((x) => x.imei)).toEqual(['356938035643809']);
    expect(r.valid[0]!.label).toBe('IMEI');
  });
  it('IMEI1 / IMEI2 are both returned, labelled, in order — none is chosen silently', () => {
    const r = core.extract('IMEI1: 490154203237518\nIMEI2: 356938035643809');
    expect(r.valid).toEqual([{ imei: '490154203237518', label: 'IMEI 1' }, { imei: '356938035643809', label: 'IMEI 2' }]);
  });
  it('several IMEIs without labels; duplicates counted once', () => {
    const r = core.extract('490154203237518;356938035643809;490154203237518');
    expect(r.valid.map((x) => x.imei)).toEqual(['490154203237518', '356938035643809']);
  });
  it('the printed grouping on a box label', () => {
    expect(core.extract('IMEI 49 015420 323751 8').valid.map((x) => x.imei)).toEqual(['490154203237518']);
  });
  it('a 15-digit run with a wrong check digit is rejected, not offered', () => {
    expect(core.extract('IMEI: 490154203237519')).toEqual({ valid: [], rejected: 1 });
  });
  it('a longer digit run (serial, EAN-like) is never cut into an IMEI', () => {
    expect(core.extract('4901542032375184').valid).toEqual([]);
    expect(core.extract('14901542032375180').valid).toEqual([]);
  });
  it('formats for display only', () => {
    expect(core.format('490154203237518')).toBe('49 015420 323751 8');
  });
});

describe('the scanner stays inside the app', () => {
  it('sends nothing anywhere: no network API in the component, only the local decoder file', () => {
    for (const api of ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'EventSource', 'toDataURL', 'toBlob', 'console.log', 'localStorage', 'location.search']) {
      expect(SRC.includes(api), api).toBe(false);
    }
    const srcs = [...SRC.matchAll(/(?:src\s*=|ZXING_SRC\s*=)\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(srcs).toEqual(['/vendor/zxing-library-0.21.3.min.js']);
  });
  it('the vendored decoder is the pinned, unmodified file', () => {
    const [sum, name] = readFileSync('apps/web/vendor/SHA256SUMS', 'utf8').trim().split(/\s+/);
    expect(name).toBe('zxing-library-0.21.3.min.js');
    expect(createHash('sha256').update(readFileSync(`apps/web/vendor/${name}`)).digest('hex')).toBe(sum);
  });
  it('qm-web serves the decoder from its own origin and allows the camera on its own page only', () => {
    const server = readFileSync('apps/web/server.mjs', 'utf8');
    expect(server).toContain("script-src 'unsafe-inline' 'self'");
    expect(server).toContain("camera=(self)");
    expect(readFileSync('apps/web/build.mjs', 'utf8')).toContain("'qm-imei.js'");
  });
});
