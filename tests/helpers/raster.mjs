// Rasterize PDF bytes with poppler and hand back pixel readers.
// This is the independent check: the app renders with pdf.js, the exports are
// read with a completely different implementation.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPPM } from './ppm.mjs';

export const DPI = 150;
export const SCALE = DPI / 72;   // PDF user-space units -> pixels

let popplerChecked = null;
export function havePoppler() {
  if (popplerChecked === null) {
    try { execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' }); popplerChecked = true; }
    catch { popplerChecked = false; }
  }
  return popplerChecked;
}

/**
 * rasterize(pdfBytes, {dpi}) -> { pages: [PPM], dir }
 * Needs poppler-utils (pdftoppm). Callers should assert havePoppler() first.
 */
export function rasterize(pdfBytes, opts = {}) {
  const dpi = opts.dpi || DPI;
  const dir = mkdtempSync(join(tmpdir(), 'keithrobat-px-'));
  const pdfPath = join(dir, 'in.pdf');
  writeFileSync(pdfPath, Buffer.from(pdfBytes));
  execFileSync('pdftoppm', ['-r', String(dpi), pdfPath, join(dir, 'page')], { stdio: 'ignore' });
  const files = readdirSync(dir).filter((f) => f.endsWith('.ppm')).sort();
  if (!files.length) throw new Error('pdftoppm produced no output — is the PDF valid?');
  const pages = files.map((f) => readPPM(readFileSync(join(dir, f))));
  return { pages, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Pull the text layer out with poppler (independent of the app's pdf.js). */
export function extractText(pdfBytes) {
  const dir = mkdtempSync(join(tmpdir(), 'keithrobat-txt-'));
  const pdfPath = join(dir, 'in.pdf');
  writeFileSync(pdfPath, Buffer.from(pdfBytes));
  try {
    return execFileSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Document info as reported by poppler.
 * Note: read this with poppler, not with pdf-lib — pdf-lib's own
 * getProducer()/getCreator() accessors return pdf-lib's defaults for files it
 * did not write, so they are not a trustworthy view of the bytes.
 */
export function pdfInfo(pdfBytes) {
  const dir = mkdtempSync(join(tmpdir(), 'keithrobat-info-'));
  const pdfPath = join(dir, 'in.pdf');
  writeFileSync(pdfPath, Buffer.from(pdfBytes));
  try {
    const out = execFileSync('pdfinfo', [pdfPath], { encoding: 'utf8' });
    const fields = {};
    for (const line of out.split('\n')) {
      const m = /^([A-Za-z ]+):\s*(.*)$/.exec(line);
      if (m) fields[m[1].trim().toLowerCase()] = m[2].trim();
    }
    fields.pages = parseInt(fields.pages, 10);
    return fields;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Convert a PDF user-space point (origin bottom-left) to raster pixel coords. */
export function toPixel(xUser, yUser, pageHeight) {
  return { x: Math.round(xUser * SCALE), y: Math.round((pageHeight - yUser) * SCALE) };
}

/** A box in pixel space from a PDF-space rect. */
export function boxOf(rect, pageHeight, dpi = DPI) {
  const s = dpi / 72;
  const x0 = Math.round(rect.x * s);
  const x1 = Math.round((rect.x + rect.w) * s);
  const y0 = Math.round((pageHeight - (rect.y + rect.h)) * s);
  const y1 = Math.round((pageHeight - rect.y) * s);
  return { x0, y0, x1, y1 };
}
