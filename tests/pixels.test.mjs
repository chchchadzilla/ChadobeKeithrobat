/**
 * Suite 2 — pixels.
 *
 * Renders what the export actually produces and reads the pixels back. The app
 * renders with pdf.js; these exports are rasterized with poppler (pdftoppm), a
 * completely separate implementation, so a bug can't hide behind a shared
 * assumption between writer and reader.
 *
 * Needs poppler-utils on PATH (pdftoppm, pdftotext).
 * Run:  node --test tests/pixels.test.mjs
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as PDFLib from 'pdf-lib';
import { loadCore } from './helpers/core.mjs';
import { rasterize, extractText, havePoppler, boxOf, DPI } from './helpers/raster.mjs';
import { encodePng } from './helpers/png.mjs';

const C = loadCore();
const { PDFDocument, StandardFonts, rgb } = PDFLib;

const W = 612, H = 792;
const NAVY = { r: 20 / 255, g: 30 / 255, b: 60 / 255 };
const NAVY_RGB = [20, 30, 60];

before(() => {
  assert.ok(havePoppler(),
    'the pixel suite needs poppler-utils for pdftoppm/pdftotext.\n' +
    '  Debian/Ubuntu: apt-get install poppler-utils\n' +
    '  macOS:         brew install poppler\n' +
    'Set SKIP_PIXELS=1 to run only the engine and integration suites.');
});

/** Build a page and apply edits to it, returning the exported bytes. */
async function exportWithEdits(pageSetup, edits, opts = {}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage(opts.size || [W, H]);
  await pageSetup(doc, page);
  if (edits && edits.length) {
    await C.drawEditsOnPage(PDFLib, doc, page, edits, {}, opts.drawOpts || {});
  }
  return doc.save();
}

function lum([r, g, b]) { return 0.299 * r + 0.587 * g + 0.114 * b; }

/** Mean RGB of a PDF-space rect, via the raster. */
function meanOfRect(ppm, rect, pageHeight = H, dpi = DPI) {
  const b = boxOf(rect, pageHeight, dpi);
  return ppm.mean(b.x0, b.y0, b.x1, b.y1);
}

/* ================================================================== *
 * control
 * ================================================================== */
test('a page with nothing on it rasterizes white', async () => {
  const bytes = await exportWithEdits(async () => {}, []);
  const { pages, cleanup } = rasterize(bytes);
  try {
    assert.equal(pages.length, 1);
    const m = pages[0].mean(0, 0, pages[0].width, pages[0].height);
    assert.ok(lum(m) > 250, `expected a white page, got ${m}`);
  } finally { cleanup(); }
});

test('the raster is the size the PDF says it is', async () => {
  const bytes = await exportWithEdits(async () => {}, []);
  const { pages, cleanup } = rasterize(bytes);
  try {
    assert.equal(pages[0].width, Math.round(W * DPI / 72));
    assert.equal(pages[0].height, Math.round(H * DPI / 72));
  } finally { cleanup(); }
});

/* ================================================================== *
 * text edits
 * ================================================================== */
test('an added text edit really puts ink on the page', async () => {
  const rect = { x: 72, y: 600, w: 300, h: 30 };
  const plain = await exportWithEdits(async () => {}, []);
  const edited = await exportWithEdits(async () => {}, [
    { kind: 'text', rect, text: 'REPLACEMENT LINE', size: 22, font: 'HelveticaBold', color: '#000000', baselineY: 604 },
  ]);
  const b = boxOf(rect, H);
  const a = rasterize(plain), c = rasterize(edited);
  try {
    assert.equal(a.pages[0].darkCount(b.x0, b.y0, b.x1, b.y1), 0, 'blank page should have no ink there');
    assert.ok(c.pages[0].darkCount(b.x0, b.y0, b.x1, b.y1) > 100, 'the drawn text should be visible');
  } finally { a.cleanup(); c.cleanup(); }
});

test('exported replacement text is selectable text, not a picture of text', async () => {
  const bytes = await exportWithEdits(async () => {}, [
    { kind: 'text', rect: { x: 72, y: 600, w: 400, h: 30 }, text: 'SELECTABLE-MARKER', size: 18, font: 'Helvetica', baselineY: 604 },
  ]);
  const text = extractText(bytes);
  assert.match(text, /SELECTABLE-MARKER/, 'poppler should find the text layer, not just pixels');
});

/* ================================================================== *
 * content-aware fill — the headline claim
 * ================================================================== */
test('a solid fill patch covers existing ink completely', async () => {
  const rect = { x: 72, y: 600, w: 300, h: 24 };
  const bytes = await exportWithEdits(async (doc, page) => {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('THIS LINE SHOULD BE COVERED BY THE PATCH BELOW', { x: 74, y: 604, size: 14, font, color: rgb(0, 0, 0) });
  }, [
    { kind: 'fill', rect, fill: { kind: 'solid', color: { r: 1, g: 1, b: 1 } } },
  ]);
  const b = boxOf(rect, H);
  const { pages, cleanup } = rasterize(bytes);
  try {
    assert.equal(pages[0].darkCount(b.x0, b.y0, b.x1, b.y1), 0, 'no ink should survive under the patch');
  } finally { cleanup(); }
});

test('white text removed from a navy slide yields flat navy, not a smeared gray band', async () => {
  // This is the README's headline claim. A naive implementation averages the
  // ring (navy background + white glyph pixels) and paints a washed-out band.
  const rect = { x: 100, y: 400, w: 400, h: 40 };
  const bytes = await exportWithEdits(async (doc, page) => {
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(NAVY.r, NAVY.g, NAVY.b) });
    page.drawText('WHITE TEXT ON NAVY THAT MUST GO AWAY', { x: 104, y: 412, size: 26, font, color: rgb(1, 1, 1) });
  }, [
    { kind: 'fill', rect, fill: { kind: 'solid', color: NAVY } },
  ]);
  const { pages, cleanup } = rasterize(bytes);
  try {
    const patched = meanOfRect(pages[0], rect);
    const reference = meanOfRect(pages[0], { x: 100, y: 300, w: 400, h: 40 }); // clean navy, no text
    const drift = Math.max(
      Math.abs(patched[0] - reference[0]),
      Math.abs(patched[1] - reference[1]),
      Math.abs(patched[2] - reference[2]),
    );
    assert.ok(drift < 20,
      `patch drifted from the surrounding navy by ${drift.toFixed(1)} per channel ` +
      `(patched ${patched.map((v) => v.toFixed(0))} vs navy ${reference.map((v) => v.toFixed(0))}) ` +
      '— this is the gray-smear failure');
    assert.ok(lum(patched) < 60, `patch luminance ${lum(patched).toFixed(1)} is too bright for navy`);
    assert.ok(Math.abs(patched[0] - NAVY_RGB[0]) < 20 && Math.abs(patched[2] - NAVY_RGB[2]) < 25,
      `patch should read as navy, got ${patched.map((v) => v.toFixed(0))}`);
  } finally { cleanup(); }
});

test('a gradient fill patch renders as a ramp, not a flat block', async () => {
  // Drive computeFill with a genuine left-to-right gradient ring, then embed the
  // pixels it produces, exactly like the app does for a non-uniform region.
  const w = 60, h = 20;
  const horiz = new Uint8ClampedArray(w * 4);
  const left = new Uint8ClampedArray(h * 4), right = new Uint8ClampedArray(h * 4);
  for (let i = 0; i < w; i++) { const v = Math.round(255 * i / (w - 1)); horiz.set([v, v, v, 255], i * 4); }
  for (let i = 0; i < h; i++) { left.set([0, 0, 0, 255], i * 4); right.set([255, 255, 255, 255], i * 4); }
  const fill = C.computeFill({ top: horiz, bottom: horiz, left, right }, w, h);
  assert.equal(fill.kind, 'image', 'precondition: the ring should be read as a gradient');
  const png = encodePng(fill.data, w, h);

  const rect = { x: 100, y: 400, w: 300, h: 100 };
  const bytes = await exportWithEdits(async () => {}, [
    { kind: 'fill', rect, fill: { kind: 'image', pngBytes: png } },
  ]);
  const { pages, cleanup } = rasterize(bytes);
  try {
    const left = meanOfRect(pages[0], { x: rect.x + 8, y: rect.y + 40, w: 30, h: 20 });
    const mid = meanOfRect(pages[0], { x: rect.x + 135, y: rect.y + 40, w: 30, h: 20 });
    const right = meanOfRect(pages[0], { x: rect.x + rect.w - 38, y: rect.y + 40, w: 30, h: 20 });
    const L = lum(left), M = lum(mid), R = lum(right);
    assert.ok(L < M && M < R, `expected a monotone ramp, got ${L.toFixed(0)} / ${M.toFixed(0)} / ${R.toFixed(0)}`);
    assert.ok(R - L > 100,
      `expected a strong ramp across the patch, got left ${L.toFixed(0)} and right ${R.toFixed(0)}`);
  } finally { cleanup(); }
});

/* ================================================================== *
 * highlight / shapes / ink
 * ================================================================== */
test('a highlight lays translucent colour over the text beneath it', async () => {
  const rect = { x: 72, y: 500, w: 260, h: 22 };
  const bytes = await exportWithEdits(async (doc, page) => {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('HIGHLIGHTED TEXT LINE', { x: 74, y: 504, size: 16, font, color: rgb(0, 0, 0) });
  }, [
    { kind: 'highlight', rect, color: '#ffe45c', opacity: 0.6 },
  ]);
  const { pages, cleanup } = rasterize(bytes);
  try {
    const m = meanOfRect(pages[0], rect);
    assert.ok(m[0] > m[2] + 25 && m[1] > m[2] + 20,
      `expected a yellow cast (r,g above b), got ${m.map((v) => v.toFixed(0))}`);
    assert.ok(lum(m) < 250, 'the highlight should be visible at all');
  } finally { cleanup(); }
});

test('a vector shape draws its stroke where the geometry says', async () => {
  const rect = { x: 100, y: 300, w: 200, h: 100 };
  const bytes = await exportWithEdits(async () => {}, [
    { kind: 'shape', shape: 'rect', rect, stroke: '#ff0000', strokeWidth: 4 },
  ]);
  const { pages, cleanup } = rasterize(bytes);
  try {
    const b = boxOf(rect, H);
    const onStroke = pages[0].mean(b.x0 - 1, b.y0, b.x1, b.y0 + 6);
    assert.ok(onStroke[0] > 150 && onStroke[1] < 100 && onStroke[2] < 100,
      `expected a red border, got ${onStroke.map((v) => v.toFixed(0))}`);
    const inside = pages[0].mean(b.x0 + 25, b.y0 + 25, b.x1 - 25, b.y1 - 25);
    assert.ok(lum(inside) > 240, 'an unfilled shape must not paint its interior');
  } finally { cleanup(); }
});

test('freehand ink follows the points it was given', async () => {
  const points = [[100, 200], [200, 200], [300, 200]];
  const bytes = await exportWithEdits(async () => {}, [
    { kind: 'ink', points, stroke: '#000000', strokeWidth: 3 },
  ]);
  const { pages, cleanup } = rasterize(bytes);
  try {
    for (const [x] of points) {
      const at = boxOf({ x: x - 3, y: 197, w: 6, h: 6 }, H);
      assert.ok(pages[0].darkCount(at.x0, at.y0, at.x1, at.y1) > 0, `no ink at x=${x}`);
    }
    const offPath = boxOf({ x: 100, y: 300, w: 200, h: 40 }, H);
    assert.equal(pages[0].darkCount(offPath.x0, offPath.y0, offPath.x1, offPath.y1), 0, 'ink leaked off the path');
  } finally { cleanup(); }
});

/* ================================================================== *
 * page ops
 * ================================================================== */
test('an extra 90-degree rotation actually rotates the rendered page', async () => {
  const src = await exportWithEdits(async (doc, page) => {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('PORTRAIT', { x: 72, y: 700, size: 24, font });
  }, []);
  const rotated = await C.applyPageOps(PDFLib, [src], [{ src: 0, page: 0, extraRotation: 90 }]);
  const rotatedBytes = await rotated.save();
  const a = rasterize(src), b = rasterize(rotatedBytes);
  try {
    assert.ok(a.pages[0].width < a.pages[0].height, 'source should render portrait');
    assert.ok(b.pages[0].width > b.pages[0].height, 'rotated page should render landscape');
    assert.equal(b.pages[0].width, a.pages[0].height, 'the axes should swap exactly');
  } finally { a.cleanup(); b.cleanup(); }
});

test('an inserted blank page renders blank at the size it was asked for', async () => {
  const src = await exportWithEdits(async () => {}, []);
  const out = await C.applyPageOps(PDFLib, [src], [
    { src: 0, page: 0 },
    { src: -1, blankW: 300, blankH: 200 },
  ]);
  const bytes = await out.save();
  const { pages, cleanup } = rasterize(bytes);
  try {
    assert.equal(pages.length, 2);
    const p2 = pages[1];
    assert.equal(p2.width, Math.round(300 * DPI / 72));
    assert.equal(p2.height, Math.round(200 * DPI / 72));
    assert.ok(lum(p2.mean(0, 0, p2.width, p2.height)) > 250, 'the blank page should be blank');
  } finally { cleanup(); }
});
