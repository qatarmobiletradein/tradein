# Vendored browser libraries

| File | Package | Version | Licence | Why |
|---|---|---|---|---|
| `zxing-library-0.21.3.min.js` | [`@zxing/library`](https://www.npmjs.com/package/@zxing/library) (`umd/index.min.js`, unmodified) | 0.21.3 | MIT (see the package) | Barcode/QR decoding **in the browser** for "Scan IMEI" when the browser has no native `BarcodeDetector` (e.g. Safari on iPhone). Loaded only on demand, served by qm-web from its own origin; no frame or image leaves the device. |

Integrity: `sha256sum apps/web/vendor/zxing-library-0.21.3.min.js` must equal the value in
`apps/web/vendor/SHA256SUMS` (checked by `tests/unit/imei.test.ts`).
