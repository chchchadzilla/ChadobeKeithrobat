/**
 * Suite 5 — text editing UX + phone layout.
 *
 * Double-click to edit, click-away applies, tool switch applies, no-op edits
 * leave no trace, Esc on a re-opened edit puts it back, fonts live in the font
 * menu, and on phones the edit field is big, the bars fit, and nothing covers
 * the page.
 *
 * Runs in any engine/device: KEITHROBAT_BROWSER / KEITHROBAT_DEVICE (helpers/app.mjs).
 * Run:  node --test tests/textedit.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as PDFLib from 'pdf-lib';
import { serveRepo, launch, openApp, loadPdf, pdfPointToClient, DEVICE } from './helpers/app.mjs';

const MOBILE = !!DEVICE;
const LINE = { text: 'Total due: $1,250.00 by November 30', x: 72, y: 660, size: 20 };
const LINE2 = { text: 'Thanks for your business', x: 72, y: 600, size: 20 };

async function pdf() {
  const doc = await PDFLib.PDFDocument.create();
  const f = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  const p = doc.addPage([612, 792]);
  p.drawText(LINE.text, { x: LINE.x, y: LINE.y, size: LINE.size, font: f });
  p.drawText(LINE2.text, { x: LINE2.x, y: LINE2.y, size: LINE2.size, font: f });
  return doc.save();
}

let server, browser;
before(async () => { server = await serveRepo(); browser = await launch(); });
after(async () => { await browser?.close(); await server?.close(); });

async function app() {
  const o = await openApp(browser, server.url);
  await loadPdf(o.page, await pdf());
  return o;
}
const at = (page, line, dx = 40) => pdfPointToClient(page, line.x + dx, line.y + line.size * 0.35);
const editorOpen = (page) => page.evaluate(() => getComputedStyle(document.getElementById('txEdit')).display !== 'none');
const editCount = (page) => page.evaluate(() => Object.values(window.__inkwell.S.edits).reduce((n, a) => n + a.length, 0));
const overlayText = (page) => page.evaluate(() => document.querySelector('.ov')?.innerText || '');
/** the field the user actually types into on this device */
const field = (page) => page.locator(MOBILE ? '#txBig' : '#txEdit');

async function openByDoubleClick(page, line, dx) {
  const pt = await at(page, line, dx);
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(150);
  await page.mouse.click(pt.x, pt.y);
  await page.locator('#txEdit').waitFor({ state: 'visible', timeout: 4000 });
}

test('a second click on selected text opens the editor, caret where you clicked (not select-all)', async () => {
  const { context, page } = await app();
  try {
    await openByDoubleClick(page, LINE, 6);   // near the start of the line
    const sel = await field(page).evaluate((t) => [t.selectionStart, t.selectionEnd, t.value]);
    assert.equal(sel[2], LINE.text, 'editor seeded with the line');
    assert.equal(sel[0], sel[1], 'caret, not a selection that the first keystroke would wipe');
    assert.ok(sel[0] <= 3, `caret should sit near the click, got ${sel[0]}`);
  } finally { await context.close(); }
});

test('clicking away applies the edit instead of throwing it away', async () => {
  const { context, page } = await app();
  try {
    await openByDoubleClick(page, LINE);
    await field(page).fill('Total due: $9,999.00');
    const away = await pdfPointToClient(page, 520, LINE.y + 30);
    await page.mouse.click(away.x, away.y);
    await page.waitForTimeout(200);
    assert.equal(await editorOpen(page), false, 'editor closed');
    assert.match(await overlayText(page), /\$9,999\.00/, 'the new text is on the page');
  } finally { await context.close(); }
});

test('switching tools applies the open edit', async () => {
  const { context, page } = await app();
  try {
    await openByDoubleClick(page, LINE);
    await field(page).fill('SWITCHED-TOOL');
    await page.evaluate(() => window.__inkwell.setTool('highlight'));
    assert.match(await overlayText(page), /SWITCHED-TOOL/);
  } finally { await context.close(); }
});

test('opening and closing without changing anything leaves no edit behind', async () => {
  const { context, page } = await app();
  try {
    await openByDoubleClick(page, LINE);
    const away = await pdfPointToClient(page, 520, LINE.y + 30);
    await page.mouse.click(away.x, away.y);
    await page.waitForTimeout(200);
    assert.equal(await editCount(page), 0, 'no fill patch / redraw for a no-op');
    assert.ok(await page.locator('#undoBtn').isDisabled(), 'nothing to undo');
  } finally { await context.close(); }
});

test('re-opening an edited line and pressing Esc puts it back exactly', async () => {
  const { context, page } = await app();
  try {
    await openByDoubleClick(page, LINE);
    await field(page).fill('FIRST EDIT');
    await field(page).press('Enter');
    await page.waitForFunction(() => document.querySelector('.ov')?.innerText.includes('FIRST EDIT'));
    const before = await editCount(page);
    // click the edited text twice: select, then edit
    const el = page.locator('.ov .ed-text', { hasText: 'FIRST EDIT' });
    const b = await el.boundingBox();
    await page.mouse.click(b.x + 10, b.y + b.height / 2);
    await page.waitForTimeout(150);
    await page.mouse.click(b.x + 10, b.y + b.height / 2);
    await page.locator('#txEdit').waitFor({ state: 'visible', timeout: 4000 });
    assert.equal(await field(page).inputValue(), 'FIRST EDIT');
    await field(page).fill('throwaway');
    await field(page).press('Escape');
    // undo re-renders the page asynchronously
    await page.waitForFunction(() => document.querySelector('.ov')?.innerText.includes('FIRST EDIT'), null, { timeout: 5000 }).catch(() => {});
    assert.match(await overlayText(page), /FIRST EDIT/, 'original edit restored');
    assert.doesNotMatch(await overlayText(page), /throwaway/);
    assert.equal(await editCount(page), before);
    assert.ok(await page.locator('#redoBtn').isDisabled(), 'cancel leaves no phantom redo');
  } finally { await context.close(); }
});

test('extra fonts live in the font menu, not as cryptic buttons', async () => {
  const { context, page } = await app();
  try {
    await openByDoubleClick(page, LINE);
    assert.equal(await page.locator('#txMyFonts, #txLoadFont').count(), 0);
    const opts = await page.$$eval('#txFont option', (o) => o.map((x) => x.textContent));
    assert.ok(opts.some((t) => /Load a font file/.test(t)), opts.join(' | '));
    // picking an action must not leave the menu stuck on it
    await page.selectOption('#txFont', 'act:ttf').catch(() => {});
    assert.notEqual(await page.locator('#txFont').inputValue(), 'act:ttf');
  } finally { await context.close(); }
});

test('Edit is the first, highlighted action on selected text', async () => {
  const { context, page } = await app();
  try {
    const pt = await at(page, LINE);
    await page.mouse.click(pt.x, pt.y);
    await page.locator('#selBar.on').waitFor();
    const first = await page.$eval('#selBar button', (b) => [b.textContent, b.className]);
    assert.deepEqual(first, ['Edit', 'primary']);
  } finally { await context.close(); }
});

if (MOBILE) {
  test('phone: the selection bar fits on screen and no info sheet covers the page', async () => {
    const { context, page } = await app();
    try {
      const pt = await at(page, LINE);
      await page.mouse.click(pt.x, pt.y);
      await page.locator('#selBar.on').waitFor();
      const r = await page.$eval('#selBar', (b) => { const x = b.getBoundingClientRect(); return { l: x.left, r: x.right, vw: innerWidth }; });
      assert.ok(r.l >= 0 && r.r <= r.vw + 1, `selBar off-screen: ${JSON.stringify(r)}`);
      assert.equal(await page.$eval('#inspector', (e) => getComputedStyle(e).display), 'none', 'text-run sheet should not pop on phones');
    } finally { await context.close(); }
  });

  test('phone: editing uses a big 16px field in the bottom bar, everything on screen', async () => {
    const { context, page } = await app();
    try {
      await openByDoubleClick(page, LINE);
      const big = await page.$eval('#txBig', (t) => {
        const cs = getComputedStyle(t), r = t.getBoundingClientRect();
        return { shown: cs.display !== 'none', fs: parseFloat(cs.fontSize), h: r.height, focused: document.activeElement === t };
      });
      assert.ok(big.shown, 'big field visible');
      assert.ok(big.fs >= 16, `font-size ${big.fs} < 16 makes iOS zoom`);
      assert.ok(big.h >= 40, 'tall enough to tap');
      assert.ok(big.focused, 'keyboard goes to the big field');
      const bar = await page.$eval('#txBar', (b) => { const r = b.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, vw: innerWidth, vh: innerHeight }; });
      assert.ok(bar.l >= 0 && bar.r <= bar.vw + 1 && bar.t >= 0 && bar.b <= bar.vh + 1, `txBar off-screen: ${JSON.stringify(bar)}`);
      await page.locator('#txBig').fill('PHONE EDIT');
      assert.equal(await page.locator('#txEdit').inputValue(), 'PHONE EDIT', 'on-page preview mirrors the field');
      await page.locator('#txApply').click();
      await page.waitForFunction(() => document.querySelector('.ov')?.innerText.includes('PHONE EDIT'));
    } finally { await context.close(); }
  });
}
