/**
 * Pure image metrics on grayscale pixel buffers. No I/O, no decoding —
 * callers hand in raw 8-bit grayscale data (row-major, 1 byte per pixel).
 */

/** 64-bit hash as two unsigned 32-bit halves [high, low]. */
export type Hash64 = [number, number];

/**
 * Difference hash (dHash): from a 9×8 grayscale thumbnail, each bit records
 * whether a pixel is brighter than its right neighbour. Robust to scaling,
 * re-compression and small colour changes.
 */
export function dHash(gray9x8: Uint8Array): Hash64 {
  if (gray9x8.length < 72) throw new Error('dHash needs a 9x8 grayscale buffer');
  let hi = 0;
  let lo = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const bit = gray9x8[y * 9 + x] > gray9x8[y * 9 + x + 1] ? 1 : 0;
      const i = y * 8 + x;
      if (i < 32) hi = (hi | (bit << (31 - i))) >>> 0;
      else lo = (lo | (bit << (63 - i))) >>> 0;
    }
  }
  return [hi, lo];
}

export function hashToHex(h: Hash64): string {
  return h[0].toString(16).padStart(8, '0') + h[1].toString(16).padStart(8, '0');
}

export function hexToHash(hex: string): Hash64 {
  return [parseInt(hex.slice(0, 8), 16) >>> 0, parseInt(hex.slice(8, 16), 16) >>> 0];
}

function popcount32(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24) & 0xff;
}

/** Number of differing bits (0 = identical, 64 = opposite). */
export function hamming(a: Hash64, b: Hash64): number {
  return popcount32((a[0] ^ b[0]) >>> 0) + popcount32((a[1] ^ b[1]) >>> 0);
}

/**
 * Variance of the Laplacian — the standard focus/blur measure. Blurry images
 * have few edges and a low variance. Compare only images analysed at the
 * same working size.
 */
export function laplacianVariance(gray: Uint8Array, w: number, h: number): number {
  if (w < 3 || h < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = gray[i - w] + gray[i + w] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/**
 * Fast noise standard-deviation estimate (Immerkær, 1996). It responds to
 * fine texture as well as sensor noise, so it is only a tie-breaker.
 */
export function noiseSigma(gray: Uint8Array, w: number, h: number): number {
  if (w < 3 || h < 3) return 0;
  let total = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v =
        gray[i - w - 1] - 2 * gray[i - w] + gray[i - w + 1] -
        2 * gray[i - 1] + 4 * gray[i] - 2 * gray[i + 1] +
        gray[i + w - 1] - 2 * gray[i + w] + gray[i + w + 1];
      total += Math.abs(v);
    }
  }
  return (total * Math.sqrt(Math.PI / 2)) / (6 * (w - 2) * (h - 2));
}

/** ITU T.81 Annex K luminance quantization table (the libjpeg baseline). */
const STD_LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87,
  80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92,
  95, 98, 112, 100, 103, 99,
];
const STD_SUM = STD_LUMA.reduce((a, b) => a + b, 0);

/**
 * Estimate the JPEG quality setting (1–100) from the luminance quantization
 * table, inverting libjpeg's quality scaling. Returns null for non-JPEG data.
 */
export function jpegQuality(buf: Uint8Array): number | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
      i += marker === 0xff ? 1 : 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // start of scan / end of image
    const len = (buf[i + 2] << 8) | buf[i + 3];
    if (marker === 0xdb) {
      let p = i + 4;
      const end = i + 2 + len;
      while (p < end) {
        const pq = buf[p] >> 4;
        const tq = buf[p] & 0x0f;
        p++;
        const table: number[] = [];
        for (let k = 0; k < 64; k++) {
          table.push(pq ? (buf[p + 2 * k] << 8) | buf[p + 2 * k + 1] : buf[p + k]);
        }
        p += pq ? 128 : 64;
        if (tq === 0) {
          const scale = (table.reduce((a, b) => a + b, 0) * 100) / STD_SUM;
          const q = scale <= 100 ? (200 - scale) / 2 : 5000 / scale;
          return Math.max(1, Math.min(100, Math.round(q)));
        }
      }
    }
    i += 2 + len;
  }
  return null;
}
