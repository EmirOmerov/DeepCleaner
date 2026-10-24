import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGroups, groupSimilar, scoreGroup, type ImageInfo } from '../../src/core/images/grouping';
import { ImageScanner } from '../../src/core/images/imageScanner';
import { dHash, hamming, jpegQuality, laplacianVariance, noiseSigma } from '../../src/core/images/metrics';

// ---------------------------------------------------------------- metrics

describe('dHash / hamming', () => {
  const ramp = Uint8Array.from({ length: 72 }, (_, i) => (i % 9) * 20); // brightness rises left→right
  const fall = Uint8Array.from({ length: 72 }, (_, i) => 200 - (i % 9) * 20);
  it('identical input → distance 0', () => expect(hamming(dHash(ramp), dHash(ramp))).toBe(0));
  it('inverted gradient → all 64 bits differ', () => expect(hamming(dHash(ramp), dHash(fall))).toBe(64));
  it('rejects short buffers', () => expect(() => dHash(new Uint8Array(10))).toThrow());
});

describe('laplacianVariance / noiseSigma', () => {
  const w = 64;
  const h = 64;
  const checker = Uint8Array.from({ length: w * h }, (_, i) => ((i % w >> 2) + ((i / w) >> 2)) % 2 ? 255 : 0);
  const flat = new Uint8Array(w * h).fill(128);
  const blur = (src: Uint8Array) =>
    Uint8Array.from(src, (_, i) => {
      const x = i % w;
      const y = (i / w) | 0;
      let s = 0;
      let n = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          s += src[yy * w + xx];
          n++;
        }
      return s / n;
    });

  it('flat image has zero sharpness and noise', () => {
    expect(laplacianVariance(flat, w, h)).toBe(0);
    expect(noiseSigma(flat, w, h)).toBe(0);
  });
  it('blurring lowers sharpness', () => {
    expect(laplacianVariance(blur(checker), w, h)).toBeLessThan(laplacianVariance(checker, w, h) / 4);
  });
});

/** A synthetic "photo": smooth gradients, a few discs and fine stripes. */
function photo(width: number, height: number, seed = 1): Buffer {
  const buf = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const u = x / width;
      const v = y / height;
      let r = 255 * u;
      let g = 255 * v * 0.8 + 30 * Math.sin(x / 7);
      let b = 200 - 150 * u * v;
      for (let k = 0; k < 3; k++) {
        const cx = (0.25 + 0.25 * k) * width;
        const cy = (0.4 + 0.15 * Math.sin(k * seed)) * height;
        if ((x - cx) ** 2 + (y - cy) ** 2 < (0.08 * width) ** 2) {
          r = 250 - 60 * k;
          g = 40 * k * seed;
          b = 90;
        }
      }
      if (seed > 1) [r, b] = [b, 255 - r];
      buf[i] = Math.max(0, Math.min(255, r));
      buf[i + 1] = Math.max(0, Math.min(255, g));
      buf[i + 2] = Math.max(0, Math.min(255, b));
    }
  }
  return buf;
}

const raw = (w: number, h: number, seed = 1) => sharp(photo(w, h, seed), { raw: { width: w, height: h, channels: 3 } });

describe('jpegQuality', () => {
  it.each([95, 80, 70, 50, 30])('recovers quality %i within ±2', async (q) => {
    const jpg = await raw(160, 120).jpeg({ quality: q, mozjpeg: false }).toBuffer();
    expect(Math.abs(jpegQuality(jpg)! - q)).toBeLessThanOrEqual(2);
  });
  it('returns null for PNG', async () => {
    expect(jpegQuality(await raw(32, 32).png().toBuffer())).toBeNull();
  });
});

// ---------------------------------------------------------------- grouping & scoring

const info = (over: Partial<ImageInfo>): ImageInfo => ({
  path: 'C:\\p\\a.jpg',
  width: 4000,
  height: 3000,
  bytes: 4_000_000,
  mtimeMs: 1,
  format: 'jpeg',
  hash: 'ffff0000ffff0000',
  sharpness: 500,
  noise: 2,
  jpegQuality: 95,
  hasExif: true,
  ...over,
});

describe('groupSimilar / scoreGroup', () => {
  it('groups near-identical hashes and leaves different ones alone', () => {
    const groups = groupSimilar([
      info({ path: 'a', hash: 'ffff0000ffff0000' }),
      info({ path: 'b', hash: 'ffff0000ffff0003' }), // 2 bits away
      info({ path: 'c', hash: '0000ffff0000ffff' }), // opposite
    ], 0.9);
    expect(groups).toHaveLength(1);
    expect(groups[0].map((g) => g.path).sort()).toEqual(['a', 'b']);
  });

  it('never groups portrait with landscape', () => {
    expect(groupSimilar([info({ path: 'a' }), info({ path: 'b', width: 3000, height: 4000 })], 0.9)).toEqual([]);
  });

  it('prefers the higher-resolution, sharper, higher-quality original', () => {
    const [best, ...rest] = scoreGroup([
      info({ path: 'whatsapp', width: 1600, height: 1200, sharpness: 200, jpegQuality: 70, hasExif: false, bytes: 300_000 }),
      info({ path: 'original' }),
      info({ path: 'blurry', sharpness: 90, jpegQuality: 85 }),
    ]);
    expect(best.path).toBe('original');
    expect(best.isBest).toBe(true);
    expect(rest.every((r) => !r.isBest && r.score < best.score)).toBe(true);
  });

  it('exact duplicates: keeps the older file', () => {
    const [best] = scoreGroup([info({ path: 'copy', mtimeMs: 200 }), info({ path: 'orig', mtimeMs: 100 })]);
    expect(best.path).toBe('orig');
  });

  it('orders groups by reclaimable bytes', () => {
    const g = buildGroups([
      info({ path: 'a1', hash: '1111111111111111', bytes: 10 }),
      info({ path: 'a2', hash: '1111111111111111', bytes: 10 }),
      info({ path: 'b1', hash: 'f0f0f0f0f0f0f0f0', bytes: 999 }),
      info({ path: 'b2', hash: 'f0f0f0f0f0f0f0f0', bytes: 999 }),
    ]);
    expect(g[0].images.map((i) => i.path).sort()).toEqual(['b1', 'b2']);
    expect(g[0].reclaimable).toBe(999);
  });
});

// ---------------------------------------------------------------- real files end-to-end

describe('ImageScanner on real JPEGs', () => {
  let dir: string;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-img-'));
    const p = (n: string) => path.join(dir, n);
    await raw(1200, 900).jpeg({ quality: 95 }).withExif({ IFD0: { Make: 'DC Camera' } }).toFile(p('IMG_2041.jpg'));
    await raw(1200, 900).resize(600, 450).jpeg({ quality: 70 }).toFile(p('IMG-WA0007.jpg'));
    await raw(1200, 900).blur(4).jpeg({ quality: 88 }).toFile(p('IMG_2041 (blur).jpg'));
    await raw(1200, 900, 3).jpeg({ quality: 95 }).toFile(p('other.jpg'));
    await raw(40, 40).png().toFile(p('icon.png')); // square, different aspect: never grouped
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('groups the three versions and picks the original as best', async () => {
    const scanner = new ImageScanner();
    const groups = await scanner.scan({ roots: [dir], minSimilarity: 0.85, minBytes: 1 });
    expect(groups).toHaveLength(1);
    const names = groups[0].images.map((i) => path.basename(i.path));
    expect(names[0]).toBe('IMG_2041.jpg');
    expect(names.sort()).toEqual(['IMG-WA0007.jpg', 'IMG_2041 (blur).jpg', 'IMG_2041.jpg']);
    const best = groups[0].images[0];
    expect(best.hasExif).toBe(true);
    expect(best.jpegQuality).toBeGreaterThanOrEqual(93);
    const blurry = groups[0].images.find((i) => i.path.includes('blur'))!;
    expect(blurry.metrics.sharpness).toBeLessThan(0.5);
  });

  it('does not keep image files locked after scanning and previewing', async () => {
    const scanner = new ImageScanner();
    await scanner.scan({ roots: [dir], minSimilarity: 0.85, minBytes: 1 });
    await scanner.preview(path.join(dir, 'IMG_2041.jpg'), 200);
    const moved = path.join(dir, 'moved.jpg');
    fs.renameSync(path.join(dir, 'IMG_2041.jpg'), moved);
    fs.renameSync(moved, path.join(dir, 'IMG_2041.jpg'));
  });

  it('only accepts paths from the current groups and can produce previews', async () => {
    const scanner = new ImageScanner();
    await scanner.scan({ roots: [dir], minSimilarity: 0.85, minBytes: 1 });
    const { known, rejected } = scanner.filterKnown([path.join(dir, 'IMG-WA0007.jpg'), path.join(dir, 'other.jpg')]);
    expect(known).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(await scanner.preview(path.join(dir, 'IMG_2041.jpg'), 200)).toMatch(/^data:image\/jpeg;base64,/);
    expect(await scanner.preview(path.join(dir, 'other.jpg'), 200)).toBeNull();
    expect(scanner.forget([path.join(dir, 'IMG-WA0007.jpg'), path.join(dir, 'IMG_2041 (blur).jpg')])).toEqual([]);
  });
});
