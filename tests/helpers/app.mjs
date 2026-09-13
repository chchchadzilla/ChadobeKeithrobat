// Boot harness for the integration suite: serves the repo over HTTP and drives
// the SHIPPED index.html in real Chrome. Nothing is stubbed — the page loads its
// own pdf.js / pdf-lib / fontkit from the CDN, exactly as a visitor would.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { chromium } from 'playwright';
import { ROOT } from './extract.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
  '.css': 'text/css',
};

export function serveRepo() {
  const server = createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const path = join(ROOT, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    const file = path.endsWith('/') ? join(path, 'index.html') : path;
    // when a build override is in play, serve that in place of the repo's copy
    const withOverride = process.env.KEITHROBAT_INDEX && file === join(ROOT, 'index.html')
      ? process.env.KEITHROBAT_INDEX
      : file;
    if (!existsSync(withOverride)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[extname(withOverride)] || 'application/octet-stream' });
    res.end(readFileSync(withOverride));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

/** Launch Chrome. Prefers a system Chrome; falls back to a Playwright download. */
export async function launch() {
  const attempts = [
    { channel: 'chrome' },
    { channel: 'chromium' },
    {},
  ];
  let lastErr;
  for (const opts of attempts) {
    try {
      return await chromium.launch({ ...opts, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    } catch (err) { lastErr = err; }
  }
  throw new Error(
    'could not launch a browser for the integration suite.\n' +
    '  Install Chrome, or run:  npx playwright install chromium\n' +
    `  Last error: ${lastErr && lastErr.message}`
  );
}

/**
 * Open the app and wait until its boot has finished (the test hook exists and
 * the toolbar is live).
 */
export async function openApp(browser, url, { collectConsole = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const messages = [];
  if (collectConsole) {
    page.on('console', (m) => messages.push({ type: m.type(), text: m.text() }));
    page.on('pageerror', (e) => messages.push({ type: 'pageerror', text: e.message }));
  }
  // Capture every Blob the app hands to the browser for download, and give the
  // tests a way to pick the one that is actually an export. The page creates a
  // couple of tiny non-PDF blobs of its own during boot, so "a blob exists" is
  // not the same as "the export is ready" — always match on the bytes.
  // NOTE: page.waitForFunction() treats a returned Promise as truthy, so the
  // readiness counter below is kept synchronous and updated from an async
  // side-check. Do not turn the predicate into an async function.
  await page.addInitScript(() => {
    window.__capturedBlobs = [];
    window.__pdfBlobCount = 0;
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      window.__capturedBlobs.push(blob);
      blob.slice(0, 5).arrayBuffer().then((buf) => {
        if (String.fromCharCode.apply(null, new Uint8Array(buf)) === '%PDF-') window.__pdfBlobCount++;
      });
      return orig(blob);
    };
    window.__lastPdfBlob = async () => {
      const blobs = window.__capturedBlobs || [];
      for (let i = blobs.length - 1; i >= 0; i--) {
        const head = new Uint8Array(await blobs[i].slice(0, 5).arrayBuffer());
        if (String.fromCharCode.apply(null, head) === '%PDF-') return blobs[i];
      }
      return null;
    };
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__inkwell, null, { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('canvas.pg') === null || true);
  return { context, page, messages };
}

/** Enter a PDF into the app through its real file input. */
export async function loadPdf(page, pdfBytes, name = 'test.pdf') {
  const b64 = Buffer.from(pdfBytes).toString('base64');
  await page.evaluate(async ({ b64, name }) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const input = document.getElementById('fileInput');
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type: 'application/pdf' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { b64, name });
  await page.waitForFunction(
    () => { const tl = document.querySelector('.tl'); return !!tl && tl.innerText.trim().length > 0; },
    null, { timeout: 15000 });
  await page.waitForTimeout(400);   // let the first render settle
}

/** Map a PDF user-space point to client coordinates on the rendered page. */
export async function pdfPointToClient(page, xUser, yUser, pageW = 612, pageH = 792) {
  return page.evaluate(({ xUser, yUser, pageW, pageH }) => {
    const canvas = document.querySelector('canvas.pg');
    const r = canvas.getBoundingClientRect();
    const sx = r.width / pageW, sy = r.height / pageH;
    return { x: r.left + xUser * sx, y: r.top + (pageH - yUser) * sy };
  }, { xUser, yUser, pageW, pageH });
}

/** Full text layer the app extracted from the loaded PDF. */
export async function pageText(page) {
  return page.evaluate(() => document.querySelector('.tl')?.innerText || '');
}

/** Wait until the app has produced a real PDF blob. */
export async function waitForExport(page, timeout = 20000) {
  await page.waitForFunction(() => (window.__pdfBlobCount || 0) > 0, null, { timeout, polling: 100 });
}

/** Read the most recent exported PDF back out as bytes. */
export async function lastExportBytes(page) {
  const b64 = await page.evaluate(async () => {
    const blob = await window.__lastPdfBlob();
    if (!blob) return null;
    const buf = await blob.arrayBuffer();
    let s = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  });
  return b64 ? Buffer.from(b64, 'base64') : null;
}
