// Extract the inline <script> blocks from the shipped index.html.
// Suite 1 and 2 test the SHIPPED file, never a copy.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
// KEITHROBAT_INDEX lets the suite run against a different build of the same
// file (kept for the mutation check, and useful in CI against an artifact).
export const INDEX = process.env.KEITHROBAT_INDEX
  ? process.env.KEITHROBAT_INDEX
  : join(ROOT, 'index.html');

export function inlineScripts() {
  const html = readFileSync(INDEX, 'utf8');
  // <script> with NO attributes = inline. External ones carry src=.
  const out = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  if (out.length < 2) throw new Error(`expected 2 inline scripts in index.html, found ${out.length}`);
  return out;
}

// The core block is the one that assigns InkwellCore.
export function coreSource() {
  const block = inlineScripts().find((s) => s.includes('InkwellCore'));
  if (!block) throw new Error('could not find the core script block (no InkwellCore assignment)');
  return block;
}

export function appSource() {
  const block = inlineScripts().find((s) => s.includes('window.__inkwell'));
  if (!block) throw new Error('could not find the app script block (no window.__inkwell hook)');
  return block;
}
