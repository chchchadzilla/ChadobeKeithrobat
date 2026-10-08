/**
 * Suite 4 — watermark + toolbar.
 *
 * Engine half: Core.stripWatermarks on fixture PDFs carrying each common kind
 * of watermark, read back with poppler. Browser half: the real page, the real
 * Watermark ▾ / Tools ▾ menus, real exports.
 *
 * Runs in any engine: KEITHROBAT_BROWSER=chromium|firefox|webkit|msedge and
 * KEITHROBAT_DEVICE="iPhone 14" etc. (see helpers/app.mjs).
 *
 * Run:  node --test tests/watermark.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as PDFLib from 'pdf-lib';
import { loadCore } from './helpers/core.mjs';
import { extractText, pdfInfo, rasterize } from './helpers/raster.mjs';
import { serveRepo, launch, openApp, loadPdf, waitForExport, lastExportBytes, DEVICE } from './helpers/app.mjs';
import { FIXTURES, MARKS, BODY, PAGES, clean } from './helpers/watermarks.mjs';

const C = loadCore();
const MOBILE = !!DEVICE;

/** True when a string is drawn anywhere in the page content (literal or hex).
 *  poppler's text extraction skips some rotated text, so check the operators. */
async function drawsText(bytes, str) {
  const d = await PDFLib.PDFDocument.load(bytes);
  const hex = Buffer.from(str, 'latin1').toString('hex').toUpperCase();
  const seen = new Set();
  const scan = (o) => {
    if (!o || seen.has(o)) return false;
    seen.add(o);
    if (o instanceof PDFLib.PDFRef) return scan(d.context.lookup(o));
    if (o instanceof PDFLib.PDFRawStream) {
      let raw = o.contents;
      try { raw = PDFLib.decodePDFRawStream(o).decode(); } catch {}
      const s = Buffer.from(raw).toString('latin1');
      if (s.includes(str) || s.toUpperCase().replace(/\s/g, '').includes(hex)) return true;
      return scan(o.dict);
    }
    if (o instanceof PDFLib.PDFDict) return [...o.asMap().entries()].some(([k, v]) => k.asString() !== '/Parent' && scan(v));
    if (o instanceof PDFLib.PDFArray) return o.asArray().some(scan);
    return false;
  };
  return d.getPages().some((p) => scan(p.node));
}

/* ================================================================== *
 * engine
 * ================================================================== */
for (const [name, make] of Object.entries(FIXTURES)) {
  test(`engine: strips the ${name} watermark and keeps the body text`, async () => {
    const bytes = await make();
    const r = await C.stripWatermarks(PDFLib, bytes);
    assert.equal(r.changed, true, 'the watermark should be detected');
    assert.deepEqual(r.pages, [0, 1, 2], 'every page carried it');
    assert.ok(await drawsText(bytes, MARKS[name]), 'fixture must actually carry the mark');
    const txt = extractText(r.bytes);
    assert.ok(!(await drawsText(r.bytes, MARKS[name])), 'watermark is still drawn');
    for (let i = 0; i < PAGES; i++) assert.ok(txt.includes(BODY(i)), `body text of page ${i + 1} was lost`);
  });
}

test('engine: a clean PDF is reported as clean and left byte-identical', async () => {
  const bytes = await clean();
  const r = await C.stripWatermarks(PDFLib, bytes);
  assert.equal(r.changed, false);
  assert.equal(r.bytes, bytes);
});

test('engine: the diagonal watermark is gone from the pixels too', async () => {
  const r = await C.stripWatermarks(PDFLib, await FIXTURES.diagonalText());
  const { pages, cleanup } = rasterize(r.bytes, { dpi: 50 });
  try {
    const pg = pages[0];
    // the mark sat across the page centre; everything below the body line is blank paper
    let dark = 0;
    for (let y = Math.round(pg.height * 0.2); y < pg.height; y++) {
      for (let x = 0; x < pg.width; x++) {
        const [r0, g0, b0] = pg.at(x, y);
        if (r0 < 245 || g0 < 245 || b0 < 245) dark++;
      }
    }
    assert.equal(dark, 0, `${dark} non-white pixels remain where the watermark was`);
  } finally { cleanup(); }
});

test('engine: scrubMetadata strips author, title, creator and XMP', async () => {
  const d = await PDFLib.PDFDocument.create();
  d.addPage();
  d.setAuthor('Jane Doe'); d.setTitle('Secret merger'); d.setCreator('LawFirm DMS'); d.setSubject('x'); d.setKeywords(['a']);
  d.catalog.set(PDFLib.PDFName.of('Metadata'), d.context.register(d.context.stream('<x:xmpmeta>Jane Doe</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' })));
  C.scrubMetadata(PDFLib, d, 'Chadobe Keithrobat Pro CK');
  const out = await d.save();
  const info = pdfInfo(out);
  assert.ok(!info.author && !info.title && !info.creator && !info.subject, JSON.stringify(info));
  assert.match(info.producer, /Keithrobat/);
  assert.ok(!Buffer.from(out).toString('latin1').includes('Jane Doe'), 'the author name is still in the file bytes');
});

/* ================================================================== *
 * browser
 * ================================================================== */
let server, browser;
before(async () => { server = await serveRepo(); browser = await launch(); });
after(async () => { if (browser) await browser.close(); if (server) await server.close(); });

async function app(bytes) {
  const o = await openApp(browser, server.url, { collectConsole: true });
  if (bytes) await loadPdf(o.page, bytes);
  return o;
}
async function tapOrClick(page, sel) {
  const loc = page.locator(sel);
  if (MOBILE && (await page.evaluate(() => 'ontouchstart' in window))) await loc.tap();
  else await loc.click();
}
async function lastToast(page) {
  await page.waitForFunction(() => document.querySelector('#toasts .toast'), null, { timeout: 15000 });
  return page.evaluate(() => { const t = document.querySelectorAll('#toasts .toast'); return t[t.length - 1].textContent; });
}
async function exportStd(page) {
  await page.evaluate(() => { window.__pdfBlobCount = 0; window.__capturedBlobs = []; });
  await page.locator('#exportBtn').click();
  await page.locator('#expGo').click();
  await waitForExport(page);
  return lastExportBytes(page);
}

test('browser: boots with SRI + CSP on, no console errors, worker verified', async () => {
  const { context, page, messages } = await app();
  try {
    const tags = await page.evaluate(() => [...document.querySelectorAll('script[src]')].map((s) => !!s.integrity && s.crossOrigin === 'anonymous'));
    assert.deepEqual(tags, [true, true, true], 'all three CDN scripts must carry integrity + crossorigin');
    assert.ok(await page.evaluate(() => !!document.querySelector('meta[http-equiv="Content-Security-Policy"]')));
    await loadPdf(page, await clean());
    assert.match(await page.evaluate(() => window.pdfjsLib.GlobalWorkerOptions.workerSrc), /^blob:/, 'the worker must run from the verified blob');
    const errors = messages.filter((m) => (m.type === 'error' || m.type === 'pageerror') && !/favicon\.ico|Failed to load resource/.test(m.text));
    assert.deepEqual(errors, [], JSON.stringify(errors));
  } finally { await context.close(); }
});

test('browser: Watermark and Tools menus open, close on Esc / outside click / pick', async () => {
  const { context, page } = await app(await clean());
  try {
    for (const [btn, dd] of [['#wmBtn', '#wmDD'], ['#toolsBtn', '#toolsDD']]) {
      await tapOrClick(page, btn);
      assert.equal(await page.locator(btn).getAttribute('aria-expanded'), 'true');
      assert.ok(await page.locator(`${dd} .ddmenu`).isVisible(), `${dd} menu should be visible`);
      const box = await page.locator(`${dd} .ddmenu`).boundingBox();
      const vw = page.viewportSize().width;
      assert.ok(box.x >= 0 && box.x + box.width <= vw + 1, `menu overflows the viewport: ${JSON.stringify(box)} vw=${vw}`);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator(btn).getAttribute('aria-expanded'), 'false');
      await tapOrClick(page, btn);
      await page.mouse.click(5, page.viewportSize().height - 60);
      assert.equal(await page.locator(btn).getAttribute('aria-expanded'), 'false', 'outside click should close');
    }
    // keyboard: focus the button, ArrowDown opens and focuses the first item
    await page.locator('#toolsBtn').focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'imageBtn');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.tool), 'highlight');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.body.dataset.tool), 'highlight');
    assert.equal(await page.locator('#toolsBtn').getAttribute('aria-expanded'), 'false', 'picking closes the menu');
    assert.ok(await page.locator('#toolsBtn').evaluate((b) => b.classList.contains('has-active')), 'Tools shows an active tool inside');
  } finally { await context.close(); }
});

test('browser: the toolbar fits / scrolls on this viewport without breaking layout', async () => {
  const { context, page } = await app(await clean());
  try {
    const r = await page.evaluate(() => {
      const tb = document.getElementById('topbar');
      return { docW: document.documentElement.scrollWidth, vw: window.innerWidth, h: tb.getBoundingClientRect().height };
    });
    assert.ok(r.docW <= r.vw + 1, `page scrolls sideways: ${r.docW} > ${r.vw}`);
    assert.ok(r.h <= 49, `topbar wrapped: ${r.h}px`);
    for (const id of ['wmBtn', 'toolsBtn', 'exportBtn']) {
      await page.locator('#' + id).scrollIntoViewIfNeeded();
      assert.ok(await page.locator('#' + id).isVisible(), `#${id} must be reachable`);
    }
  } finally { await context.close(); }
});

for (const name of Object.keys(FIXTURES)) {
  test(`browser: Watermark ▾ → Remove strips "${name}" from the export; undo restores it`, async () => {
    const { context, page } = await app(await FIXTURES[name]());
    try {
      await tapOrClick(page, '#wmBtn');
      await tapOrClick(page, '#wmRemoveBtn');
      assert.match(await lastToast(page), /Removed watermark from 3 pages/);
      const out = await exportStd(page);
      const txt = extractText(out);
      assert.ok(!(await drawsText(out, MARKS[name])), 'watermark survived the export');
      for (let i = 0; i < PAGES; i++) assert.ok(txt.includes(BODY(i)), `page ${i + 1} body lost`);

      await page.locator('#undoBtn').click();
      await page.waitForTimeout(300);
      assert.ok(await drawsText(await exportStd(page), MARKS[name]), 'undo did not bring the watermark back');
    } finally { await context.close(); }
  });
}

test('browser: Remove on a clean PDF says so and changes nothing', async () => {
  const { context, page } = await app(await clean());
  try {
    await tapOrClick(page, '#wmBtn');
    await tapOrClick(page, '#wmRemoveBtn');
    assert.match(await lastToast(page), /No watermark found/);
    assert.match(await lastToast(page), /no OCR/);
    assert.equal(await page.evaluate(() => window.__inkwell.S.undo.length), 0, 'nothing should be pushed to history');
  } finally { await context.close(); }
});

test('browser: Watermark ▾ → Add stamps every page, and Remove takes it back off', async () => {
  const { context, page } = await app(await clean());
  try {
    await tapOrClick(page, '#wmBtn');
    await tapOrClick(page, '#wmAddBtn');
    assert.ok(await page.locator('#stampModal').isVisible());
    assert.ok(!(await page.locator('#stNumFs').isVisible()), 'Add watermark should not show page-number options');
    await page.locator('#stWmText').fill('TOPSECRET');
    await page.locator('#stApply').click();
    await page.waitForTimeout(300);
    const withMark = await exportStd(page);
    const d = await PDFLib.PDFDocument.load(withMark);
    for (let i = 0; i < 3; i++) {
      const one = await PDFLib.PDFDocument.create();
      one.addPage((await one.copyPages(d, [i]))[0]);
      assert.ok(await drawsText(await one.save(), 'TOPSECRET'), `page ${i + 1} is missing the watermark`);
    }

    await tapOrClick(page, '#wmBtn');
    await tapOrClick(page, '#wmRemoveBtn');
    assert.match(await lastToast(page), /Removed watermark from 3 pages/);
    assert.ok(!(await drawsText(await exportStd(page), 'TOPSECRET')), 'the added watermark survived Remove');
  } finally { await context.close(); }
});

test('browser: the splash "watermark removal" chip opens a file and strips it on load', async () => {
  const { context, page } = await app();
  try {
    const bytes = Buffer.from(await FIXTURES.artifact()).toString('base64');
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#wmChip').click();
    const fc = await chooser;
    await fc.setFiles({ name: 'wm.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes, 'base64') });
    assert.match(await lastToast(page), /Removed watermark from 3 pages/);
  } finally { await context.close(); }
});

test('browser: saved PDFs carry no author / title / creator metadata', async () => {
  const d = await PDFLib.PDFDocument.load(await clean());
  d.setAuthor('Jane Doe'); d.setTitle('Secret merger'); d.setCreator('LawFirm DMS');
  const { context, page } = await app(await d.save());
  try {
    const out = await exportStd(page);
    const info = pdfInfo(out);
    assert.ok(!info.author && !info.title && !info.creator, JSON.stringify(info));
    assert.ok(!Buffer.from(out).toString('latin1').includes('Jane Doe'));
  } finally { await context.close(); }
});
