// Per-track overlay assets — generate the QR code + cache the cover image
// to local disk so FFmpeg has fast, stable paths to read from. Cleaned up
// when the process exits.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import QRCode from "qrcode";

const TMP_DIR = path.join(os.tmpdir(), "taksym-stream");
fs.mkdirSync(TMP_DIR, { recursive: true });

/**
 * Render a QR code for the given URL as a PNG file. Returns the file path.
 * High error-correction so the code stays scannable through the FFmpeg
 * scaling, JPEG-style stream compression, and viewer-end re-encode.
 */
export async function makeQRPng(url, id) {
  const out = path.join(TMP_DIR, `qr-${id}.png`);
  await QRCode.toFile(out, url, {
    errorCorrectionLevel: "H",
    margin: 2,
    width: 240,
    color: {
      dark: "#FFFFFFFF",
      light: "#00000000", // transparent background
    },
  });
  return out;
}

// Catalog API returns relative URLs like `/assets/albums/foo.png`. The
// browser resolves them against the current origin; Node's `fetch()` won't.
// Anchor against the configured site origin (defaults to production).
const SITE_ORIGIN = process.env.SITE_ORIGIN ?? "https://www.taksym.com";

function absoluteUrl(url) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `${SITE_ORIGIN}${url}`;
  return `${SITE_ORIGIN}/${url}`;
}

/**
 * Download a remote cover image and cache it locally. FFmpeg works much
 * better with a local file path than a remote URL (no re-fetch each track).
 */
export async function fetchCover(url, id) {
  const abs = absoluteUrl(url);
  if (!abs) throw new Error(`cover url empty`);
  const out = path.join(TMP_DIR, `cover-${id}.jpg`);
  if (fs.existsSync(out)) return out;
  const res = await fetch(abs);
  if (!res.ok) throw new Error(`cover fetch failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(out, buf);
  return out;
}

/** Escape a string for safe use inside an FFmpeg drawtext filter. */
export function ffmpegEscape(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%");
}

export { TMP_DIR };
