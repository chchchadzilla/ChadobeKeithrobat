// Load the shipped core engine in Node.
// The core is a UMD factory inside index.html: it exports itself via
// module.exports when `module` exists, so we compile the extracted source
// as CommonJS and hand back the exports object. Tests therefore exercise the
// exact bytes that ship, not a copy.
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coreSource } from './extract.mjs';

const require = createRequire(import.meta.url);

let cached = null;

export function loadCore() {
  if (cached) return cached;
  const src = coreSource();
  const tag = createHash('sha256').update(src).digest('hex').slice(0, 16);
  const dir = join(tmpdir(), 'keithrobat-tests');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `core-${tag}.cjs`);
  writeFileSync(file, src);
  cached = require(file);
  return cached;
}
