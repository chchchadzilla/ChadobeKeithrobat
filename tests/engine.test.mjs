/**
 * Suite 1 — engine.
 *
 * Pure computational core, no DOM, no browser. Drives the SAME core source that
 * index.html ships (see helpers/core.mjs) with pdf-lib injected the same way the
 * browser app injects it.
 *
 * Run:  node --test tests/engine.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
// The browser hands the whole pdf-lib namespace to the core as `PDFLib`
// (window.PDFLib), so the tests inject the same shape of object.
import * as PDFLib from 'pdf-lib';
import { loadCore } from './helpers/core.mjs';

const C = loadCore();
const { PDFDocument, StandardFonts } = PDFLib;

/* ------------------------------------------------------------------ *
 * ring-buffer builder for computeFill: a border ring around a w x h patch
 * ------------------------------------------------------------------ */
function ring(w, h, fn) {
  const mk = (len, axis, which) => {
    const buf = new Uint8ClampedArray(len * 4);
    for (let i = 0; i < len; i++) {
      const [r, g, b] = fn(i, axis, which);
      buf[i * 4] = r; buf[i * 4 + 1] = g; buf[i * 4 + 2] = b; buf[i * 4 + 3] = 255;
    }
    return buf;
  };
  return {
    top: mk(w, 'x', 'top'),
    bottom: mk(w, 'x', 'bottom'),
    left: mk(h, 'y', 'left'),
    right: mk(h, 'y', 'right'),
  };
}

/* ================================================================== *
 * cleanFontName
 * ================================================================== */
test('cleanFontName strips a PDF subset prefix', () => {
  assert.equal(C.cleanFontName('ABCDEF+Helvetica'), 'Helvetica');
  assert.equal(C.cleanFontName('ABCDEF+TimesNewRomanPS-BoldItalicMT'), 'TimesNewRomanPS-BoldItalicMT');
});

test('cleanFontName strips pdf.js internal font ids', () => {
  assert.equal(C.cleanFontName('g_d0_f3 (Calibri-Bold)'), '(Calibri-Bold)');
  assert.equal(C.cleanFontName('g_d12_f104'), '');
});

test('cleanFontName tolerates empty and null', () => {
  assert.equal(C.cleanFontName(''), '');
  assert.equal(C.cleanFontName(null), '');
  assert.equal(C.cleanFontName(undefined), '');
});

test('cleanFontName leaves an already-clean name alone', () => {
  assert.equal(C.cleanFontName('ArialNarrow'), 'ArialNarrow');
});

/* ================================================================== *
 * matchFont
 * ================================================================== */
test('matchFont: Helvetica -> sans / Helvetica', () => {
  const m = C.matchFont('Helvetica');
  assert.equal(m.family, 'sans');
  assert.equal(m.std, 'Helvetica');
  assert.equal(m.bold, false);
  assert.equal(m.italic, false);
  assert.equal(m.confidence, 0.9);
});

test('matchFont: subset-tagged serif with a weight maps to TimesRomanBold', () => {
  const m = C.matchFont('ABCDEF+Garamond-SemiBold');
  assert.equal(m.family, 'serif');
  assert.equal(m.bold, true);
  assert.equal(m.std, 'TimesRomanBold');
});

test('matchFont: bold + italic serif -> TimesRomanBoldItalic', () => {
  const m = C.matchFont('TimesNewRomanPS-BoldItalicMT');
  assert.equal(m.std, 'TimesRomanBoldItalic');
  assert.equal(m.bold, true);
  assert.equal(m.italic, true);
});

test('matchFont: italic alone -> TimesRomanItalic', () => {
  assert.equal(C.matchFont('Georgia-Italic').std, 'TimesRomanItalic');
});

test('matchFont: monospace family wins over other signals', () => {
  for (const name of ['Courier New', 'Consolas', 'Menlo', 'DejaVu Sans Mono', 'Liberation Mono']) {
    assert.equal(C.matchFont(name).family, 'mono', `${name} should be mono`);
  }
});

test('matchFont: mono weight/style matrix', () => {
  assert.equal(C.matchFont('Courier').std, 'Courier');
  assert.equal(C.matchFont('Courier-Bold').std, 'CourierBold');
  assert.equal(C.matchFont('Courier-Oblique').std, 'CourierOblique');
  assert.equal(C.matchFont('Courier-BoldOblique').std, 'CourierBoldOblique');
});

test('matchFont: plain sans families', () => {
  for (const name of ['Arial', 'ArialNarrow', 'Verdana', 'Calibri', 'Segoe UI', 'Roboto', 'Helvetica-Bold']) {
    assert.equal(C.matchFont(name).family, 'sans', `${name} should be sans`);
  }
});

test('matchFont: a name containing "sans" is never classified serif', () => {
  // SERIF_RX would match some of these on the "roman"/"serif" tokens, so the
  // classifier guards with !/sans/. Regression guard for that guard.
  assert.equal(C.matchFont('DejaVu Sans').family, 'sans');
  assert.equal(C.matchFont('Noto Sans').family, 'sans');
  assert.equal(C.matchFont('Source Sans Pro').family, 'sans');
});

test('matchFont: bold tokens the app must recognise', () => {
  for (const t of ['Bold', 'Black', 'Heavy', 'ExtraBold', 'UltraBold', 'SemiBold', 'DemiBold']) {
    assert.equal(C.matchFont(`SomeFont-${t}`).bold, true, `${t} should read as bold`);
  }
});

test('matchFont: italic tokens the app must recognise', () => {
  for (const t of ['Italic', 'Oblique', 'Kursiv']) {
    assert.equal(C.matchFont(`SomeFont-${t}`).italic, true, `${t} should read as italic`);
  }
});

test('matchFont: unknown name falls back to sans at reduced confidence', () => {
  const m = C.matchFont('TotallyUnknownFace');
  assert.equal(m.family, 'sans');
  assert.equal(m.confidence, 0.5);
});

test('matchFont: empty name is low-confidence sans, never a throw', () => {
  const m = C.matchFont('');
  assert.equal(m.family, 'sans');
  assert.equal(m.confidence, 0.3);
});

test('matchFont: pdf.js internal id still resolves through the wrapper form', () => {
  const m = C.matchFont('g_d0_f3 (Calibri-Bold)');
  assert.equal(m.family, 'sans');
  assert.equal(m.bold, true);
});

test('matchFont always returns a CSS stack consistent with the family', () => {
  for (const [name, needle] of [
    ['Times New Roman', 'serif'],
    ['Helvetica', 'sans-serif'],
    ['Courier New', 'monospace'],
  ]) {
    assert.match(C.matchFont(name).css, new RegExp(needle));
  }
});

/* ================================================================== *
 * parseFontName / matchCustomFont
 * ================================================================== */
test('parseFontName extracts base + style flags', () => {
  assert.deepEqual(C.parseFontName('ABCDEF+MyriadPro'), { base: 'myriadpro', bold: false, italic: false });
  assert.deepEqual(C.parseFontName('Garamond-SemiBold'), { base: 'garamond', bold: true, italic: false });
  assert.deepEqual(C.parseFontName('Times-Roman'), { base: 'times', bold: false, italic: false });
});

// KNOWN QUIRK (characterization, not endorsement): the italic-flags regexes
// understand the "BoldIt" suffix, but the base-stripping regex does not, so the
// trailing "it" survives into `base`. Consequence: a BoldIt name still matches
// its family, but through substring containment (score 1) instead of exact
// equality (score 2). Flagged to the author; if it gets fixed, this test flips
// to { base: 'myriadpro' }.
test('parseFontName: BoldIt suffix leaks "it" into the base name', () => {
  assert.deepEqual(C.parseFontName('MyriadPro-BoldIt'), { base: 'myriadproit', bold: true, italic: true });
});

test('a BoldIt document font still resolves to the right custom family', () => {
  const m = C.matchCustomFont('ABCDEF+MyriadPro-BoldIt', ['Helvetica', 'Myriad Pro']);
  assert.equal(m.family, 'Myriad Pro');
  assert.equal(m.bold, true);
  assert.equal(m.italic, true);
});

test('matchCustomFont prefers an exact family over a substring', () => {
  const m = C.matchCustomFont('ABCDEF+Garamond-SemiBold', ['Georgia', 'Garamond', 'Garamond Pro Display']);
  assert.equal(m.family, 'Garamond');
  assert.equal(m.score, 2);
  assert.equal(m.bold, true);
});

test('matchCustomFont falls back to substring containment', () => {
  const m = C.matchCustomFont('HelveticaNeueLTStd', ['Helvetica Neue', 'Times']);
  assert.equal(m.family, 'Helvetica Neue');
  assert.equal(m.score, 1);
});

test('matchCustomFont returns null for an empty document font name', () => {
  assert.equal(C.matchCustomFont('', ['Arial']), null);
  assert.equal(C.matchCustomFont(null, ['Arial']), null);
});

test('matchCustomFont returns null when nothing matches', () => {
  assert.equal(C.matchCustomFont('ZapfDingbats', ['Arial', 'Georgia']), null);
});

test('matchCustomFont does not leak its internal length bookkeeping', () => {
  const m = C.matchCustomFont('MyriadPro', ['Myriad Pro']);
  assert.equal('_fl' in m, false);
});

/* ================================================================== *
 * fitTextSize — the anti-reflow guarantee
 * ================================================================== */
const measure = (t, s) => t.length * s;

test('fitTextSize leaves text that already fits at its original size', () => {
  assert.equal(C.fitTextSize(measure, 'short', 12, 1000), 12);
});

test('fitTextSize scales down proportionally when the text overflows', () => {
  // 10 chars at 12pt = 120 wide; 60 of room -> 6pt
  assert.equal(C.fitTextSize(measure, '0123456789', 12, 60), 6);
});

test('fitTextSize never scales UP past the original size', () => {
  assert.equal(C.fitTextSize(measure, 'ab', 20, 5000), 20);
});

test('fitTextSize floors at 4pt so text can never vanish', () => {
  assert.equal(C.fitTextSize(measure, 'x'.repeat(100), 12, 10), 4);
});

test('fitTextSize returns the base size for empty text or zero width', () => {
  assert.equal(C.fitTextSize(measure, '', 12, 50), 12);
  assert.equal(C.fitTextSize(measure, 'overflowing text', 12, 0), 12);
});

test('fitTextSize result always measures within the box when the box is sane', () => {
  const cases = [['hello world', 18, 90], ['a much longer replacement line', 11, 120], ['X', 40, 5]];
  for (const [t, base, max] of cases) {
    const s = C.fitTextSize(measure, t, base, max);
    if (s > 4) assert.ok(measure(t, s) <= max + 1e-9, `"${t}" at ${s} should fit in ${max}`);
  }
});

/* ================================================================== *
 * geometry
 * ================================================================== */
test('normRect normalizes corners regardless of drag direction', () => {
  assert.deepEqual(C.normRect([10, 20], [30, 5]), { x: 10, y: 5, w: 20, h: 15 });
  assert.deepEqual(C.normRect([30, 5], [10, 20]), { x: 10, y: 5, w: 20, h: 15 });
  assert.deepEqual(C.normRect([5, 5], [5, 5]), { x: 5, y: 5, w: 0, h: 0 });
});

test('rectsIntersect is true only for genuine overlap', () => {
  const a = { x: 0, y: 0, w: 10, h: 10 };
  assert.equal(C.rectsIntersect(a, { x: 5, y: 5, w: 10, h: 10 }), true);
  assert.equal(C.rectsIntersect(a, { x: 10, y: 0, w: 10, h: 10 }), false, 'touching edges are not an overlap');
  assert.equal(C.rectsIntersect(a, { x: 0, y: 10, w: 10, h: 10 }), false);
  assert.equal(C.rectsIntersect(a, { x: 100, y: 100, w: 1, h: 1 }), false);
});

test('clampRectToPage caps a rect that runs off the right/bottom edge', () => {
  assert.deepEqual(C.clampRectToPage({ x: 600, y: 10, w: 100, h: 50 }, 612, 792), { x: 600, y: 10, w: 12, h: 50 });
  assert.deepEqual(C.clampRectToPage({ x: 10, y: 780, w: 50, h: 50 }, 612, 792), { x: 10, y: 780, w: 50, h: 12 });
});

// The origin is moved to the page edge and the size is kept, so a rect that
// starts off-page is shifted in rather than clipped shorter.
test('clampRectToPage pulls a negative origin onto the page and keeps the size', () => {
  assert.deepEqual(C.clampRectToPage({ x: -30, y: -30, w: 60, h: 60 }, 612, 792), { x: 0, y: 0, w: 60, h: 60 });
});

test('clampRectToPage never returns a negative size', () => {
  const r = C.clampRectToPage({ x: 9999, y: 9999, w: 10, h: 10 }, 612, 792);
  assert.ok(r.w >= 0 && r.h >= 0);
});

test('scalePointsToRect rescales a shape to a new bounding box', () => {
  const pts = [[0, 0], [10, 0], [10, 10]];
  const out = C.scalePointsToRect(pts, { x: 0, y: 0, w: 10, h: 10 }, { x: 100, y: 200, w: 20, h: 40 });
  assert.deepEqual(out, [[100, 200], [120, 200], [120, 240]]);
});

test('scalePointsToRect falls back to a 1:1 ratio for a degenerate source rect', () => {
  // A zero-width source rect cannot produce a scale factor, so the guard uses
  // 1 and the points are translated only.
  assert.deepEqual(C.scalePointsToRect([[1, 1], [2, 2]], { x: 0, y: 0, w: 0, h: 0 }, { x: 5, y: 5, w: 10, h: 10 }), [[6, 6], [7, 7]]);
});

/* ================================================================== *
 * colors
 * ================================================================== */
test('rgbToHex emits lowercase 6-digit hex', () => {
  assert.equal(C.rgbToHex(44, 45, 59), '#2c2d3b');
  assert.equal(C.rgbToHex(255, 0, 0), '#ff0000');
  assert.equal(C.rgbToHex(0, 0, 0), '#000000');
});

test('rgbToHex clamps and rounds out-of-range channels', () => {
  assert.equal(C.rgbToHex(-5, 300, 127.6), '#00ff80');
});

test('hexToRgb01 parses hex into 0..1 floats', () => {
  const c = C.hexToRgb01('#ff0000');
  assert.deepEqual(c, { r: 1, g: 0, b: 0 });
  const navy = C.hexToRgb01('#2c2d3b');
  assert.ok(Math.abs(navy.r - 44 / 255) < 1e-9);
});

test('hexToRgb01 accepts a bare hex string and rejects junk', () => {
  assert.deepEqual(C.hexToRgb01('00ff00'), { r: 0, g: 1, b: 0 });
  assert.deepEqual(C.hexToRgb01('#fff'), { r: 0, g: 0, b: 0 }, 'short hex is not supported');
  assert.deepEqual(C.hexToRgb01(''), { r: 0, g: 0, b: 0 });
  assert.deepEqual(C.hexToRgb01(null), { r: 0, g: 0, b: 0 });
});

test('rgbToHex and hexToRgb01 round-trip', () => {
  const hex = C.rgbToHex(18, 140, 200);
  const back = C.hexToRgb01(hex);
  assert.deepEqual(C.rgbToHex(back.r * 255, back.g * 255, back.b * 255), hex);
});

/* ================================================================== *
 * parsePageRange
 * ================================================================== */
test('parsePageRange: empty or "all" selects every page', () => {
  assert.deepEqual(C.parsePageRange('', 3), [0, 1, 2]);
  assert.deepEqual(C.parsePageRange(null, 3), [0, 1, 2]);
  assert.deepEqual(C.parsePageRange('all', 3), [0, 1, 2]);
  assert.deepEqual(C.parsePageRange('ALL', 3), [0, 1, 2]);
});

test('parsePageRange: ranges and singles, 1-based input', () => {
  assert.deepEqual(C.parsePageRange('1-3,7', 10), [0, 1, 2, 6]);
  assert.deepEqual(C.parsePageRange('2', 5), [1]);
});

test('parsePageRange swaps a reversed range instead of failing', () => {
  assert.deepEqual(C.parsePageRange('3-1', 5), [0, 1, 2]);
});

test('parsePageRange clamps out-of-bounds pages', () => {
  assert.deepEqual(C.parsePageRange('99', 5), [4]);
  assert.deepEqual(C.parsePageRange('1-999', 3), [0, 1, 2]);
});

test('parsePageRange dedupes but keeps order', () => {
  assert.deepEqual(C.parsePageRange('2,2,1,2', 5), [1, 0]);
});

test('parsePageRange tolerates sloppy whitespace', () => {
  assert.deepEqual(C.parsePageRange(' 1 , 2 ', 5), [0, 1]);
  assert.deepEqual(C.parsePageRange('1 - 2', 5), [0, 1]);
});

test('parsePageRange returns null on garbage rather than guessing', () => {
  assert.equal(C.parsePageRange('abc', 5), null);
  assert.equal(C.parsePageRange('1-', 5), null);
  assert.equal(C.parsePageRange('-3', 5), null);
  assert.equal(C.parsePageRange('1..3', 5), null);
});

/* ================================================================== *
 * searchItems
 * ================================================================== */
test('searchItems finds every occurrence in every item, case-insensitively', () => {
  const items = [{ str: 'Hello World' }, { str: 'hello again' }];
  assert.deepEqual(C.searchItems(items, 'hello'), [{ item: 0, at: 0 }, { item: 1, at: 0 }]);
});

test('searchItems reports repeated matches inside one item', () => {
  assert.deepEqual(C.searchItems([{ str: 'aaa' }], 'a'), [{ item: 0, at: 0 }, { item: 0, at: 1 }, { item: 0, at: 2 }]);
});

test('searchItems returns nothing for an empty query or a miss', () => {
  assert.deepEqual(C.searchItems([{ str: 'abc' }], ''), []);
  assert.deepEqual(C.searchItems([{ str: 'abc' }], 'zzz'), []);
});

/* ================================================================== *
 * edit ordering — the z-order guarantee
 * ================================================================== */
test('orderEditIndices puts every fill patch before everything else', () => {
  const eds = [{ kind: 'text' }, { kind: 'fill' }, { kind: 'image' }, { kind: 'fill' }];
  assert.deepEqual(C.orderEditIndices(eds), [1, 3, 0, 2]);
});

test('orderEditIndices preserves relative order within each class', () => {
  const eds = [{ kind: 'fill' }, { kind: 'text' }, { kind: 'fill' }, { kind: 'shape' }];
  assert.deepEqual(C.orderEditIndices(eds), [0, 2, 1, 3]);
});

test('orderEditIndices handles an empty or missing list', () => {
  assert.deepEqual(C.orderEditIndices([]), []);
  assert.deepEqual(C.orderEditIndices(null), []);
});

/* ================================================================== *
 * page-list model
 * ================================================================== */
test('rotateEntry accumulates and wraps rotation', () => {
  assert.equal(C.rotateEntry({}, 90).extraRotation, 90);
  assert.equal(C.rotateEntry({ extraRotation: 90 }, 90).extraRotation, 180);
  assert.equal(C.rotateEntry({ extraRotation: 0 }, -90).extraRotation, 270);
  assert.equal(C.rotateEntry({ extraRotation: 270 }, 180).extraRotation, 90);
});

test('moveEntry reorders a page list', () => {
  assert.deepEqual(C.moveEntry(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(C.moveEntry(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
});

test('moveEntry ignores a no-op or an out-of-range source', () => {
  const list = ['a', 'b', 'c'];
  assert.deepEqual(C.moveEntry(['a', 'b', 'c'], 1, 1), ['a', 'b', 'c']);
  assert.deepEqual(C.moveEntry(list, -1, 2), ['a', 'b', 'c']);
  assert.deepEqual(C.moveEntry(list, 9, 0), ['a', 'b', 'c']);
});

test('moveEntry clamps an over-range destination', () => {
  assert.deepEqual(C.moveEntry(['a', 'b', 'c'], 0, 99), ['b', 'c', 'a']);
});

/* ================================================================== *
 * computeFill — the headline claim: dark slide, flat navy, no gray smear
 * ================================================================== */
test('computeFill: uniform ring becomes a solid color', () => {
  const out = C.computeFill(ring(20, 20, () => [255, 255, 255]), 20, 20);
  assert.equal(out.kind, 'solid');
  assert.ok(Math.abs(out.color.r - 1) < 0.01 && Math.abs(out.color.g - 1) < 0.01);
});

test('computeFill: uniform navy stays navy, not averaged toward gray', () => {
  const out = C.computeFill(ring(30, 30, () => [20, 30, 60]), 30, 30);
  assert.equal(out.kind, 'solid');
  assert.ok(Math.abs(out.color.r - 20 / 255) < 0.02, `red channel drifted: ${out.color.r}`);
  assert.ok(Math.abs(out.color.b - 60 / 255) < 0.02, `blue channel drifted: ${out.color.b}`);
});

test('computeFill: foreign glyph ink in the ring is rejected, not blended in', () => {
  // navy background with 12 near-white samples = a neighbouring line of text
  // crossing the sampling ring. Naive averaging would wash the patch gray.
  let n = 0;
  const out = C.computeFill(ring(40, 40, () => (n++ % 13 === 0 ? [250, 250, 252] : [20, 30, 60])), 40, 40);
  assert.equal(out.kind, 'solid', 'contaminated ring should still resolve to a flat patch');
  const asByte = out.color.r * 255;
  assert.ok(asByte < 40, `patch was polluted by glyph ink: red=${asByte}`);
});

test('computeFill: a genuine gradient produces an interpolated image patch', () => {
  const out = C.computeFill(ring(40, 40, (i, axis) => {
    const t = i / 39;
    return axis === 'x' ? [255 * t, 255 * t, 255 * t] : [0, 0, 0];
  }), 40, 40);
  assert.equal(out.kind, 'image');
  assert.equal(out.data.length, 40 * 40 * 4);
  assert.equal(out.data[3], 255, 'patch pixels are opaque');
});

test('computeFill: an entirely transparent ring falls back to white, never NaN', () => {
  const blank = new Uint8ClampedArray(20 * 4);
  const out = C.computeFill({ top: blank, bottom: blank, left: blank, right: blank }, 20, 20);
  assert.equal(out.kind, 'solid');
  assert.equal(out.color.r, 1);
});

/* ================================================================== *
 * removeBackground
 * ================================================================== */
function solidImage(w, h, [r, g, b]) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255; }
  return d;
}

test('removeBackground clears a uniform background completely', () => {
  const res = C.removeBackground(solidImage(8, 8, [255, 255, 255]), 8, 8, 32);
  assert.equal(res.removedRatio, 1);
  assert.equal(res.data[3], 0);
});

test('removeBackground leaves a high-contrast subject standing', () => {
  const w = 20, h = 20, d = solidImage(w, h, [255, 255, 255]);
  for (let y = 8; y < 12; y++) for (let x = 8; x < 12; x++) {
    const o = (y * w + x) * 4; d[o] = 0; d[o + 1] = 0; d[o + 2] = 0;
  }
  const res = C.removeBackground(d, w, h, 32);
  assert.ok(res.removedRatio > 0.9, 'background should be gone');
  const centre = (10 * w + 10) * 4;
  assert.equal(res.data[centre + 3], 255, 'the subject must not be cut');
});

test('removeBackground tolerance gates how far from the seed color it reaches', () => {
  const w = 8, h = 8;
  const build = () => {
    const d = solidImage(w, h, [255, 255, 255]);
    for (let y = 3; y < 5; y++) for (let x = 3; x < 5; x++) {
      const o = (y * w + x) * 4; d[o] = 250; d[o + 1] = 250; d[o + 2] = 250;
    }
    return d;
  };
  const strict = C.removeBackground(build(), w, h, 0);
  const loose = C.removeBackground(build(), w, h, 16);
  const centre = (4 * w + 4) * 4 + 3;
  // at 0 tolerance the near-white island survives, but it still sits next to
  // removed pixels, so the edge-feather pass trims its alpha
  assert.ok(strict.data[centre] > 0, 'a 5-level difference must survive a 0 tolerance');
  assert.ok(strict.data[centre] < 255, 'a surviving island still gets a feathered edge');
  assert.ok(strict.removedRatio < 1);
  assert.equal(loose.data[centre], 0, 'a 16 tolerance should swallow the near-white patch');
  assert.ok(loose.removedRatio > strict.removedRatio);
});

test('removeBackground feathers the cut edge and leaves the interior solid', () => {
  const w = 20, h = 20, d = solidImage(w, h, [255, 255, 255]);
  for (let y = 8; y < 12; y++) for (let x = 8; x < 12; x++) {
    const o = (y * w + x) * 4; d[o] = 0; d[o + 1] = 0; d[o + 2] = 0;
  }
  const res = C.removeBackground(d, w, h, 32);
  const at = (x, y) => res.data[(y * w + x) * 4 + 3];
  assert.equal(at(0, 0), 0, 'background is fully transparent');
  assert.equal(at(10, 10), 255, 'the middle of the subject is untouched');
  // the subject's own boundary pixels sit next to removed pixels, so they ramp
  const boundary = at(8, 10);
  assert.ok(boundary > 0 && boundary < 255, `boundary alpha should ramp, got ${boundary}`);
});

test('removeBackground honours a caller-supplied tolerance', () => {
  const w = 6, h = 6, d = solidImage(w, h, [255, 255, 255]);
  assert.equal(C.removeBackground(new Uint8ClampedArray(d), w, h, 0).removedRatio, 1);
  assert.equal(C.removeBackground(new Uint8ClampedArray(d), w, h, 255).removedRatio, 1);
});

test('autoPickTolerance returns a candidate from the ladder, never an off-menu value', () => {
  const ladder = [10, 16, 22, 28, 36, 44, 54, 66, 80];
  const w = 24, h = 24, d = solidImage(w, h, [255, 255, 255]);
  for (let y = 9; y < 15; y++) for (let x = 9; x < 15; x++) {
    const o = (y * w + x) * 4; d[o] = 30; d[o + 1] = 30; d[o + 2] = 30;
  }
  const pick = C.autoPickTolerance(d, w, h);
  assert.ok(ladder.includes(pick.tolerance), `tolerance ${pick.tolerance} is not on the ladder`);
  assert.equal(pick.curve.length, ladder.length);
  assert.ok(pick.ratio >= 0 && pick.ratio <= 1);
});

test('autoPickTolerance: a fully-removable image is picked low, not maxed out', () => {
  const pick = C.autoPickTolerance(solidImage(16, 16, [255, 255, 255]), 16, 16);
  assert.equal(pick.tolerance, 10, 'the elbow is the first rung when everything is background');
});

test('featherAlpha only softens the boundary, never the interior', () => {
  const w = 9, h = 9, d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) d[i * 4 + 3] = 255;
  for (let x = 0; x < w; x++) { const o = (4 * w + x) * 4 + 3; d[o] = 0; }   // a row of holes
  C.featherAlpha(d, w, h, 1);
  assert.equal(d[(2 * w + 4) * 4 + 3], 255, 'interior alpha must stay fully opaque');
  assert.ok(d[(3 * w + 4) * 4 + 3] < 255, 'adjacent row should pick up a ramp');
});

/* ================================================================== *
 * smoothStroke — the signature smoother
 * ================================================================== */
test('smoothStroke pins both endpoints exactly', () => {
  const pts = [];
  for (let i = 0; i < 60; i++) pts.push([i * 4, (i % 2 ? 3 : -3)]);
  const out = C.smoothStroke(pts, 4);
  assert.deepEqual(out[0], pts[0]);
  assert.deepEqual(out[out.length - 1], pts[pts.length - 1]);
});

// A hand-drawn straight-ish line: endpoints are true (they get pinned), the
// jitter lives in the middle. Deviation is measured away from the pinned ends.
function jitterLine(n = 80, amp = 4) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const y = (i === 0 || i === n - 1) ? 0 : (i % 2 ? amp : -amp);
    pts.push([i * 3, y]);
  }
  return pts;
}
const interiorDev = (out) => Math.max(...out.slice(3, -3).map((p) => Math.abs(p[1])));

test('smoothStroke collapses tremor toward the intended line', () => {
  const pts = jitterLine();
  const smoothed = interiorDev(C.smoothStroke(pts, 5));
  assert.ok(smoothed < 1.5, `tremor barely moved: 4px of jitter is still ${smoothed}px`);
});

test('smoothStroke hands back a stroke too short to smooth untouched', () => {
  assert.deepEqual(C.smoothStroke([[0, 0], [10, 10]], 3), [[0, 0], [10, 10]]);
  assert.deepEqual(C.smoothStroke([], 3), []);
  assert.deepEqual(C.smoothStroke(null, 3), []);
});

test('smoothStroke clamps its level into 1..6', () => {
  const pts = [];
  for (let i = 0; i < 60; i++) pts.push([i * 3, (i % 2 ? 5 : -5)]);
  const over = C.smoothStroke(pts, 99);
  const six = C.smoothStroke(pts, 6);
  const under = C.smoothStroke(pts, 0);
  const one = C.smoothStroke(pts, 1);
  assert.deepEqual(over, six);
  assert.deepEqual(under, one);
});

test('smoothStroke re-spaces the stroke at an even arc length', () => {
  const pts = [[0, 0], [40, 0], [200, 0], [201, 0]];   // wildly uneven input
  const out = C.smoothStroke(pts, 2);
  const gaps = [];
  for (let i = 1; i < out.length; i++) gaps.push(Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]));
  const interior = gaps.slice(2, -2);
  const max = Math.max(...interior), min = Math.min(...interior);
  assert.ok(max / min < 1.6, `spacing is not even: ${min}..${max}`);
  assert.ok(min > 1, 'samples collapsed on top of each other');
});

test('smoothStroke smooths harder at a higher level', () => {
  // A longer-wavelength wobble is what the level knob actually controls; the
  // level-1 window already flattens a per-sample zigzag on its own.
  const pts = [];
  for (let i = 0; i < 200; i++) pts.push([i * 3, (i === 0 || i === 199) ? 0 : 10 * Math.sin(i / 10)]);
  const one = interiorDev(C.smoothStroke(pts, 1));
  const six = interiorDev(C.smoothStroke(pts, 6));
  assert.ok(six < one, `level 6 should leave less residual wobble than level 1 (${six} vs ${one})`);
  assert.ok(six > 0, 'a long wobble should be damped, not deleted');
});

test('smoothStroke damping is monotone: more passes never add tremor back', () => {
  let stroke = jitterLine(120, 6);
  let prev = interiorDev(stroke);
  const original = prev;
  for (let pass = 0; pass < 4; pass++) {
    stroke = C.smoothStroke(stroke, 3);
    const now = interiorDev(stroke);
    assert.ok(now <= prev + 1e-9, `pass ${pass + 1} increased the tremor (${prev} -> ${now})`);
    prev = now;
  }
  assert.ok(prev < original, 'the stroke should end smoother than it started');
});

/* ================================================================== *
 * PDF-touching core (pdf-lib injected exactly like the browser does)
 * ================================================================== */
async function threePageDoc() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const label of ['PAGE-ONE', 'PAGE-TWO', 'PAGE-THREE']) {
    const p = doc.addPage([612, 792]);
    p.drawText(label, { x: 72, y: 700, size: 18, font });
  }
  return doc.save();
}

test('applyPageOps copies pages in the requested order', async () => {
  const src = await threePageDoc();
  const out = await C.applyPageOps(PDFLib, [src], [
    { src: 0, page: 2 }, { src: 0, page: 0 },
  ]);
  assert.equal(out.getPageCount(), 2);
  const bytes = await out.save();
  const reread = await PDFDocument.load(bytes);
  assert.equal(reread.getPageCount(), 2);
});

test('applyPageOps inserts a blank page at the requested size', async () => {
  const src = await threePageDoc();
  const out = await C.applyPageOps(PDFLib, [src], [
    { src: 0, page: 0 }, { src: -1, blankW: 200, blankH: 100 },
  ]);
  const blank = out.getPage(1);
  const { width, height } = blank.getSize();
  assert.equal(width, 200);
  assert.equal(height, 100);
});

test('applyPageOps applies extra rotation on top of the source rotation', async () => {
  const src = await threePageDoc();
  const out = await C.applyPageOps(PDFLib, [src], [{ src: 0, page: 0, extraRotation: 90 }]);
  assert.equal(out.getPage(0).getRotation().angle, 90);
});

test('applyPageOps merges pages from a second source document', async () => {
  const a = await threePageDoc();
  const b = await PDFDocument.create();
  b.addPage([612, 792]);
  const bBytes = await b.save();
  const out = await C.applyPageOps(PDFLib, [a, bBytes], [
    { src: 0, page: 0 }, { src: 1, page: 0 },
  ]);
  assert.equal(out.getPageCount(), 2);
});

test('drawEditsOnPage paints every supported edit kind without throwing', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const edits = [
    { kind: 'fill', rect: { x: 10, y: 10, w: 50, h: 20 }, fill: { kind: 'solid', color: { r: 1, g: 1, b: 1 } } },
    { kind: 'text', rect: { x: 10, y: 300, w: 200, h: 20 }, text: 'replacement text', size: 12, font: 'Helvetica', color: '#111111' },
    { kind: 'highlight', rect: { x: 20, y: 200, w: 100, h: 14 }, color: '#ffe45c' },
    { kind: 'shape', shape: 'rect', rect: { x: 30, y: 100, w: 60, h: 40 }, stroke: '#ff0000', strokeWidth: 2 },
    { kind: 'shape', shape: 'ellipse', rect: { x: 30, y: 40, w: 60, h: 40 }, stroke: '#00ff00' },
    { kind: 'shape', shape: 'arrow', points: [[10, 10], [80, 80]], stroke: '#0000ff', strokeWidth: 1 },
    { kind: 'ink', points: [[5, 5], [15, 20], [25, 10]], stroke: '#111111', strokeWidth: 2 },
  ];
  await C.drawEditsOnPage(PDFLib, doc, page, edits, {}, {});
  const bytes = await doc.save();
  assert.ok(bytes.length > 0);
  const reread = await PDFDocument.load(bytes);
  assert.equal(reread.getPageCount(), 1);
});

test('drawEditsOnPage shrinks an oversized replacement instead of overflowing', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  const long = 'a'.repeat(120);
  await C.drawEditsOnPage(PDFLib, doc, page,
    [{ kind: 'text', rect: { x: 10, y: 100, w: 50, h: 14 }, text: long, size: 12, font: 'Helvetica' }], {}, {});
  const font = await doc.embedFont(StandardFonts.Helvetica);
  assert.ok(font.widthOfTextAtSize(long, 12) > 50, 'precondition: the text really does overflow at 12pt');
  const bytes = await doc.save();
  assert.ok(bytes.length > 0, 'export must still succeed');
});

test('fillAndFlattenForms bakes values in and removes the interactive fields', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const form = doc.getForm();
  form.createTextField('full_name').addToPage(page, { x: 50, y: 300, width: 200, height: 20 });
  const blank = await doc.save();

  const filled = await C.fillAndFlattenForms(PDFLib, blank, {
    full_name: { type: 'text', value: 'Chad Keith' },
  });
  assert.notEqual(Buffer.from(filled).toString('base64'), Buffer.from(blank).toString('base64'));

  const reread = await PDFDocument.load(filled);
  assert.equal(reread.getForm().getFields().length, 0, 'fields should be flattened away');
});

test('fillAndFlattenForms leaves a PDF with no form completely untouched', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  const plain = await doc.save();
  const out = await C.fillAndFlattenForms(PDFLib, plain, { ghost: { type: 'text', value: 'x' } });
  assert.equal(out, plain, 'the original bytes should be returned by reference');
});

test('fillAndFlattenForms returns early when there are no values to set', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  const plain = await doc.save();
  assert.equal(await C.fillAndFlattenForms(PDFLib, plain, {}), plain);
});
