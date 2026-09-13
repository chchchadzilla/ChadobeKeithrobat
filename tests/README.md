# Tests

Three suites, 116 tests. They run against the shipped `index.html`, not a copy
of it: the engine and pixel suites pull the core `<script>` out of the real file
at run time, and the integration suite loads the real file in a real browser.

```bash
npm install          # pdf-lib + playwright (dev only)
npm test             # all three suites
```

Never `npm install --save` here: the app itself has no dependencies. The whole
product is `index.html`.

## What each suite covers

| Suite | Command | What it is |
|---|---|---|
| engine | `npm run test:engine` | 90 tests. The pure core, in Node, no DOM. |
| pixels | `npm run test:pixels` | 12 tests. Renders exports and reads the pixels back. |
| integration | `npm run test:integration` | 14 tests. The real page in real Chrome. |

### engine

Drives the core engine directly. The core is a UMD factory inside `index.html`
that exports itself under Node, so the suite compiles the extracted source and
calls it with pdf-lib injected the same way the browser injects it. That means
there is no second copy of the logic to drift.

Covers font matching and classification, custom-font resolution, text fit-to-box,
geometry, colour conversion, page-range parsing, text search, edit z-ordering,
the page-list model, content-aware fill, background removal, stroke smoothing,
and the pdf-lib-facing functions (page ops, edit drawing, form fill and flatten).

### pixels

Exports real PDFs and rasterizes them with poppler, then reads the pixels. The
app renders with pdf.js and these tests read with a different implementation, so
writer and reader cannot share a bug.

This is where the visual claims are checked: that a removal patch on a dark slide
comes back flat navy instead of a smeared grey band, that a gradient patch
renders as a ramp, that shapes and ink land on their stated geometry, and that a
rotated page really renders landscape.

Needs poppler:

```bash
apt-get install poppler-utils      # Debian/Ubuntu
brew install poppler               # macOS
```

### integration

Boots the shipped file in Chrome and drives it with real mouse and keyboard
events: load a PDF, click a line of text, check the inspector reports the
embedded font it matched, edit in place, undo, redo, drag text, switch tools by
keyboard, and export.

Exports are read back with poppler, not with the app, and the suite asserts that
the app makes **no outbound request** during load, edit or export beyond its own
three CDN libraries. That is the test that guards the "your file never leaves
this device" promise.

Chrome is required; Playwright will use a system Chrome, or run
`npx playwright install chromium` to fetch one.

## The mutation check

```bash
npm run test:mutate
```

A suite that passes against a broken build is not a suite. This script breaks
`index.html` four different ways and fails unless the tests notice each one:

- fills stop rendering first (breaks the z-order guarantee)
- content-aware fill stops rejecting neighbouring glyph ink (the grey-smear bug)
- the app posts the document to a server during export (breaks the privacy claim)
- the export's producer metadata is dropped

If a mutation escapes, that behaviour is untested, no matter how green the run
looks.

## Layout

```
tests/
  engine.test.mjs           core engine, Node only
  pixels.test.mjs           rasterize exports, read pixels
  integration.test.mjs      the shipped file in a real browser
  mutation-check.sh         prove the suite actually bites
  helpers/
    extract.mjs             pull the inline scripts out of index.html
    core.mjs                compile the extracted core and load it in Node
    raster.mjs              pdftoppm / pdftotext / pdfinfo wrappers
    ppm.mjs                 minimal binary PPM reader
    png.mjs                 minimal PNG encoder (RGBA, no deps)
    app.mjs                 static server + browser harness for the shipped page
```

## Notes for whoever touches this next

- **The suite tests the shipped file.** If you split `index.html` into separate
  files, `helpers/extract.mjs` is the one place that needs to learn the new
  layout.
- **`KEITHROBAT_INDEX=/path/to/build.html`** points all three suites at a
  different build of the same file. The mutation check uses it; CI can too.
- **`page.waitForFunction` treats a returned Promise as truthy.** The export
  readiness check uses a synchronous counter for this reason. Do not make that
  predicate `async` — it will pass instantly and every export assertion after it
  becomes meaningless.
- Export readiness is decided by content (`%PDF-`), not by "a blob exists": the
  page creates a couple of tiny blobs of its own during boot.
- `pdf-lib`'s `getProducer()` is not a reliable reader for files it did not
  write. Read export metadata with poppler (`pdfinfo`).
