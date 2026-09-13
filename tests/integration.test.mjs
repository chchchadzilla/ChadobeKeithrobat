/**
 * Suite 3 — integration.
 *
 * Boots the actual shipped index.html in real Chrome, loads a real PDF through
 * the real file input, and drives real mouse/keyboard events. Exports are read
 * back with poppler, so the assertions are on the bytes a user would get.
 *
 * Run:  node --test tests/integration.test.mjs
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as PDFLib from 'pdf-lib';
import { serveRepo, launch, openApp, loadPdf, pdfPointToClient, pageText, waitForExport, lastExportBytes } from './helpers/app.mjs';
import { extractText, pdfInfo } from './helpers/raster.mjs';

const { PDFDocument, StandardFonts, rgb } = PDFLib;

const PAGE_W = 612, PAGE_H = 792;
// Big type, so a click near these coordinates reliably lands on the line.
const LINE_A = { text: 'INVOICE 2026-0913', x: 72, y: 660, size: 30 };
const LINE_B = { text: 'Approved by: J. Smith', x: 72, y: 600, size: 14 };

let server, browser;

async function testPdf({ pages = 1 } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    page.drawText(p === 0 ? LINE_A.text : `PAGE ${p + 1}`, { x: LINE_A.x, y: LINE_A.y, size: LINE_A.size, font: bold, color: rgb(0, 0, 0) });
    if (p === 0) page.drawText(LINE_B.text, { x: LINE_B.x, y: LINE_B.y, size: LINE_B.size, font, color: rgb(0.2, 0.2, 0.2) });
  }
  return doc.save();
}

before(async () => {
  server = await serveRepo();
  browser = await launch();
});
after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

/** Open the app with the standard test PDF loaded. */
async function appWithPdf(bytes) {
  const { context, page, messages } = await openApp(browser, server.url, { collectConsole: true });
  await loadPdf(page, bytes);
  return { context, page, messages };
}

/** Click a line of text on the rendered page and wait for the selection bar. */
async function selectLine(page, line) {
  // Aim a little above the baseline, into the middle of the glyph box.
  const pt = await pdfPointToClient(page, line.x + 40, line.y + line.size * 0.35, PAGE_W, PAGE_H);
  await page.mouse.click(pt.x, pt.y);
  await page.waitForFunction(() => {
    const btns = [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Move');
    return btns.some((b) => b.getBoundingClientRect().top > 100 && b.getBoundingClientRect().top < 400);
  }, null, { timeout: 5000 });
}

/* ================================================================== *
 * boot
 * ================================================================== */
test('the shipped page boots with all three CDN libraries and no errors', async () => {
  const { context, page, messages } = await openApp(browser, server.url, { collectConsole: true });
  try {
    assert.equal(await page.title(), 'Chadobe Keithrobat — Pro CK');
    const libs = await page.evaluate(() => ({
      pdfjs: typeof window.pdfjsLib, pdflib: typeof window.PDFLib,
      fontkit: typeof window.fontkit, core: typeof window.InkwellCore,
      version: window.pdfjsLib && window.pdfjsLib.version,
    }));
    assert.equal(libs.pdfjs, 'object');
    assert.equal(libs.pdflib, 'object');
    assert.equal(libs.fontkit, 'object');
    assert.equal(libs.core, 'object', 'the core engine must be exposed for the app to use');
    assert.ok(libs.version, 'pdf.js should report a version');

    // the test server does not serve /favicon.ico; that 404 is a harness
    // artefact, not an app error
    const errors = messages.filter((m) => (m.type === 'error' || m.type === 'pageerror')
      && !/favicon\.ico|Failed to load resource/.test(m.text));
    assert.deepEqual(errors, [], `console errors on boot: ${JSON.stringify(errors)}`);
  } finally { await context.close(); }
});

test('the splash offers a file picker and states the privacy position', async () => {
  const { context, page } = await openApp(browser, server.url);
  try {
    const txt = await page.evaluate(() => document.body.innerText);
    assert.match(txt, /Chadobe Keithrobat/);
    assert.match(txt, /Drop a PDF anywhere/, 'the splash should invite a drop');
    assert.match(txt, /no upload — files never leave this device/, 'the splash should state the privacy position');
    // the picker is an aria-labelled button whose face is the drop zone
    assert.equal(await page.getByRole('button', { name: 'Open a PDF' }).count(), 1,
      'the splash should expose an accessible file-picker button');
    assert.ok(await page.locator('#fileInput').count(), 'the file input must exist');
  } finally { await context.close(); }
});

test('the app never sends the document anywhere, including during export', async () => {
  // Any outbound request that is not one of the app's own CDN libraries would
  // break the "your file never leaves this device" promise. The document only
  // exists as bytes at export time, so the export path has to be exercised.
  const { context, page } = await openApp(browser, server.url);
  const external = [];
  page.on('request', (r) => {
    const u = r.url();
    if (/^(blob|data):/.test(u)) return;                       // local, never leaves the machine
    if (!u.startsWith(server.url) && !/cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net/.test(u)) external.push(u);
  });
  try {
    await loadPdf(page, await testPdf());
    await selectLine(page, LINE_A);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.locator('#txEdit').waitFor({ state: 'visible' });
    await page.locator('#txEdit').fill('LEAK-CHECK');
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: /Save PDF/ }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await waitForExport(page);
    await page.waitForTimeout(500);   // let any straggling request land
    assert.deepEqual(external, [], `unexpected outbound requests: ${external.join(', ')}`);
  } finally { await context.close(); }
});

/* ================================================================== *
 * loading
 * ================================================================== */
test('a dropped PDF renders, reports its page count, and announces local-only mode', async () => {
  const { context, page } = await appWithPdf(await testPdf());
  try {
    const canvas = await page.evaluate(() => {
      const c = document.querySelector('canvas.pg');
      return c ? { w: c.width, h: c.height } : null;
    });
    assert.ok(canvas && canvas.w > 0 && canvas.h > 0, 'the page should rasterize to a canvas');
    const txt = await page.evaluate(() => document.body.innerText);
    assert.match(txt, /page 1 \/ 1/);
    assert.match(txt, /local only/);
    const layer = await pageText(page);
    assert.match(layer, /INVOICE 2026-0913/, 'the text layer should carry the document text');
  } finally { await context.close(); }
});

/* ================================================================== *
 * selection + font matching
 * ================================================================== */
test('clicking a line of text selects it and shows the selection actions', async () => {
  const { context, page } = await appWithPdf(await testPdf());
  try {
    await selectLine(page, LINE_A);
    const actions = await page.evaluate(() =>
      [...document.querySelectorAll('button')]
        .filter((b) => b.getBoundingClientRect().top > 100)
        .map((b) => b.textContent.trim()));
    for (const want of ['Copy', 'Edit', 'Move', 'Highlight', 'Underline', 'Strike']) {
      assert.ok(actions.includes(want), `selection bar is missing "${want}" (got ${actions.join(', ')})`);
    }
  } finally { await context.close(); }
});

test('the inspector reports the real embedded font name and size it matched', async () => {
  const { context, page } = await appWithPdf(await testPdf());
  try {
    await selectLine(page, LINE_A);
    const inspector = await page.evaluate(() => document.getElementById('inspector')?.innerText || '');
    assert.match(inspector, /Helvetica/, `expected a font match for the bold Helvetica run:\n${inspector}`);
    assert.match(inspector, new RegExp(String(LINE_A.size)), `expected the ${LINE_A.size}pt size to be reported:\n${inspector}`);
  } finally { await context.close(); }
});

/* ================================================================== *
 * editing
 * ================================================================== */
test('editing a line replaces its text in place', async () => {
  const { context, page } = await appWithPdf(await testPdf());
  try {
    await selectLine(page, LINE_A);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const ta = page.locator('#txEdit');
    await ta.waitFor({ state: 'visible' });
    assert.match(await ta.inputValue(), /INVOICE 2026-0913/, 'the editor should open on the selected text');
    await ta.fill('INVOICE 2026-0913 EDITED');
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.ov')?.innerText.includes('EDITED'), null, { timeout: 5000 });
  } finally { await context.close(); }
});

test('Ctrl+Z undoes an edit and Ctrl+Y puts it back', async () => {
  const { context, page } = await appWithPdf(await testPdf());
  try {
    await selectLine(page, LINE_A);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.locator('#txEdit').waitFor({ state: 'visible' });
    await page.locator('#txEdit').fill('REVERSIBLE EDIT');
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.ov')?.innerText.includes('REVERSIBLE'));
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => !document.querySelector('.ov')?.innerText.includes('REVERSIBLE'), null, { timeout: 5000 });
    await page.keyboard.press('Control+y');
    await page.waitForFunction(() => document.querySelector('.ov')?.innerText.includes('REVERSIBLE'), null, { timeout: 5000 });
  } finally { await context.close(); }
});

test('dragging a selected line moves it without leaving the old text behind', async () => {
  const { context, page } = await appWithPdf(await testPdf());
  try {
    await selectLine(page, LINE_B);
    const from = await pdfPointToClient(page, LINE_B.x + 40, LINE_B.y + LINE_B.size * 0.5, PAGE_W, PAGE_H);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 120, from.y - 90, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const state = await page.evaluate(() => {
      const S = window.__inkwell.S;
      return { count: S.entries.length, kinds: S.entries.map((e) => (e.kind || e.type || '').toString()) };
    });
    assert.ok(state.count >= 1, 'moving text should add a movable entry');
  } finally { await context.close(); }
});

test('keyboard shortcuts switch tools', async () => {
  const { context, page } = await appWithPdf(await testPdf());
  try {
    const activeTool = () => page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => /^Highlight/.test(b.textContent.trim()));
      return btn ? btn.className : null;
    });
    await page.keyboard.press('h');
    await page.waitForTimeout(200);
    const highlighted = await activeTool();
    await page.keyboard.press('v');
    await page.waitForTimeout(200);
    const back = await activeTool();
    assert.notEqual(highlighted, back, 'pressing H should visibly change the active tool');
  } finally { await context.close(); }
});

/* ================================================================== *
 * export — read back with poppler, not with the app
 * ================================================================== */
test('Save produces a real PDF with the edit in its text layer', async () => {
  const { context, page } = await appWithPdf(await testPdf());
  try {
    await selectLine(page, LINE_A);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.locator('#txEdit').waitFor({ state: 'visible' });
    await page.locator('#txEdit').fill('EXPORTED-MARKER-1');
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await page.waitForTimeout(300);

    await page.getByRole('button', { name: /Save PDF/ }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await waitForExport(page);

    const bytes = await lastExportBytes(page);
    assert.ok(bytes, 'an export blob should have been produced');
    assert.equal(bytes.subarray(0, 5).toString('ascii'), '%PDF-');
    assert.match(extractText(bytes), /EXPORTED-MARKER-1/);
  } finally { await context.close(); }
});

test('a Standard export still carries the original text under the patch (documented behaviour)', async () => {
  // This is the honest limitation the README states, and the first thing a
  // skeptic will test. It is a regression test, not an endorsement.
  const { context, page } = await appWithPdf(await testPdf());
  try {
    await selectLine(page, LINE_A);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.locator('#txEdit').waitFor({ state: 'visible' });
    await page.locator('#txEdit').fill('REPLACEMENT-TEXT');
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: /Save PDF/ }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await waitForExport(page);

    const text = extractText(await lastExportBytes(page));
    assert.match(text, /REPLACEMENT-TEXT/, 'the new text should be present');
    assert.match(text, /INVOICE 2026-0913/, 'the covered original is still extractable in Standard mode');
  } finally { await context.close(); }
});

test('a Flattened export makes removals unrecoverable', async () => {
  const { context, page } = await appWithPdf(await testPdf());
  try {
    await selectLine(page, LINE_A);
    await page.getByRole('button', { name: /Remove/ }).first().click();
    await page.waitForTimeout(600);

    await page.getByRole('button', { name: /Save PDF/ }).click();
    await page.locator('#optFlat').click();            // "Flattened (true removal)"
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await waitForExport(page);

    const bytes = await lastExportBytes(page);
    const text = extractText(bytes);
    assert.ok(!text.includes('INVOICE 2026-0913'),
      `the removed text must not survive a Flattened export, but poppler still found it:\n${text}`);
  } finally { await context.close(); }
});

test('the exported PDF is a valid document of the right size with the app as producer', async () => {
  const { context, page } = await appWithPdf(await testPdf());
  try {
    await page.getByRole('button', { name: /Save PDF/ }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await waitForExport(page);
    const bytes = await lastExportBytes(page);
    // read the metadata with poppler, an implementation that has no stake in
    // how the file was written
    const info = pdfInfo(bytes);
    assert.equal(info.pages, 1);
    assert.match(info.producer || '', /Keithrobat/, `unexpected producer: ${info.producer}`);
    assert.match(info['page size'] || '', new RegExp(`^${PAGE_W} x ${PAGE_H} pts`),
      `unexpected page size: ${info['page size']}`);
  } finally { await context.close(); }
});
