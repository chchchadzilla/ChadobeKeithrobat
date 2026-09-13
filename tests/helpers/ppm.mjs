// Minimal binary PPM (P6) reader — the format pdftoppm emits by default.
// Raw RGB, so no image decoder dependency is needed.

export function readPPM(buf) {
  if (buf[0] !== 0x50 || buf[1] !== 0x36) throw new Error('not a binary PPM (expected P6)');
  let i = 2;
  const token = () => {
    while (i < buf.length) {
      const c = buf[i];
      if (c === 0x23) { while (i < buf.length && buf[i] !== 0x0a) i++; }        // # comment
      else if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
    let start = i;
    while (i < buf.length && ![0x20, 0x09, 0x0a, 0x0d].includes(buf[i])) i++;
    return buf.toString('ascii', start, i);
  };
  const width = parseInt(token(), 10);
  const height = parseInt(token(), 10);
  const maxVal = parseInt(token(), 10);
  if (maxVal !== 255) throw new Error(`unsupported PPM maxval ${maxVal}`);
  i++; // single whitespace after the header
  const data = buf.subarray(i);
  if (data.length < width * height * 3) throw new Error('truncated PPM payload');

  return {
    width,
    height,
    /** RGB triple at a pixel coordinate (origin top-left). */
    at(x, y) {
      const o = (y * width + x) * 3;
      return [data[o], data[o + 1], data[o + 2]];
    },
    /** Average RGB over a box, clamped to the image. */
    mean(x0, y0, x1, y1) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = Math.max(0, y0 | 0); y < Math.min(height, y1 | 0); y++) {
        for (let x = Math.max(0, x0 | 0); x < Math.min(width, x1 | 0); x++) {
          const o = (y * width + x) * 3;
          r += data[o]; g += data[o + 1]; b += data[o + 2]; n++;
        }
      }
      return n ? [r / n, g / n, b / n] : [0, 0, 0];
    },
    /** Count pixels darker than a luminance threshold inside a box. */
    darkCount(x0, y0, x1, y1, threshold = 128) {
      let n = 0;
      for (let y = Math.max(0, y0 | 0); y < Math.min(height, y1 | 0); y++) {
        for (let x = Math.max(0, x0 | 0); x < Math.min(width, x1 | 0); x++) {
          const o = (y * width + x) * 3;
          const lum = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
          if (lum < threshold) n++;
        }
      }
      return n;
    },
  };
}
