// Fixture PDFs carrying the common kinds of watermark, built with pdf-lib so
// the tests own every byte. Each fixture also has normal body text that must
// survive removal.
import * as P from 'pdf-lib';
const { PDFDocument, StandardFonts, degrees, rgb, PDFName, PDFString, PDFRawStream } = P;

export const BODY = (i) => `Body text page ${i + 1}`;
export const PAGES = 3;

async function base(fn, n = PAGES) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < n; i++) {
    const p = d.addPage([612, 792]);
    p.drawText(BODY(i), { x: 72, y: 700, size: 18, font: f, color: rgb(0, 0, 0) });
    if (fn) await fn(d, p, f, i);
  }
  return d;
}

/** Append raw operators to a page's content and give it the font as /F0. */
function appendOps(d, p, f, ops) {
  p.node.setFontDictionary(PDFName.of('WMF'), f.ref);
  const s = d.context.flateStream(ops);
  p.node.addContentStream(d.context.register(s));
}

export async function diagonalText() {
  return (await base((d, p, f) => p.drawText('CONFIDENTIAL', {
    x: 150, y: 250, size: 60, font: f, rotate: degrees(45), opacity: 0.2, color: rgb(0.5, 0.5, 0.5) }))).save();
}

export async function annotation() {
  return (await base((d, p, f) => {
    const ap = d.context.flateStream(
      'BT /WMF 48 Tf 0.6 g 20 40 Td (WATERMARK ANNOT) Tj ET',
      { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 500, 100], Resources: { Font: { WMF: f.ref } } });
    const apRef = d.context.register(ap);
    const annot = d.context.obj({ Type: 'Annot', Subtype: 'Watermark', Rect: [50, 300, 550, 400], F: 4, AP: { N: apRef } });
    p.node.addAnnot(d.context.register(annot));
  })).save();
}

export async function artifact() {
  return (await base((d, p, f) => appendOps(d, p, f,
    '/Artifact <</Type /Pagination /Subtype /Watermark>> BDC q 0.7 g BT /WMF 54 Tf 100 380 Td (ARTIFACT MARK) Tj ET Q EMC'))).save();
}

export async function layer() {
  const d = await base(null);
  const ocg = d.context.register(d.context.obj({ Type: 'OCG', Name: PDFString.of('Watermark') }));
  d.catalog.set(PDFName.of('OCProperties'), d.context.obj({ OCGs: [ocg], D: { ON: [ocg], Order: [ocg] } }));
  const f = await d.embedFont(StandardFonts.Helvetica);
  d.getPages().forEach((p) => {
    p.node.set(PDFName.of('Resources'), p.node.Resources());
    const props = d.context.obj({ MC0: ocg });
    p.node.Resources().set(PDFName.of('Properties'), props);
    appendOps(d, p, f, '/OC /MC0 BDC 0.7 g BT /WMF 50 Tf 120 380 Td (LAYER MARK) Tj ET EMC');
  });
  return d.save();
}

export async function translucentRepeated() {
  // upright, translucent, same on every page (the "Sample" footer-banner kind)
  return (await base((d, p, f) => p.drawText('SAMPLE COPY', {
    x: 160, y: 380, size: 40, font: f, opacity: 0.25, color: rgb(0.4, 0.4, 0.4) }))).save();
}

export async function clean() { return (await base(null)).save(); }

export const MARKS = {
  diagonalText: 'CONFIDENTIAL', annotation: 'WATERMARK ANNOT', artifact: 'ARTIFACT MARK',
  layer: 'LAYER MARK', translucentRepeated: 'SAMPLE COPY',
};
export const FIXTURES = { diagonalText, annotation, artifact, layer, translucentRepeated };
