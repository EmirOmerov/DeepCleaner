import * as fs from 'node:fs';
import * as path from 'node:path';
import sharp from 'sharp';
import { walkFiles } from '../fsutil';
import { SKIP_DIRS } from '../largefiles/largeFiles';
import { buildGroups, type ImageGroup, type ImageInfo } from './grouping';
import { dHash, hashToHex, jpegQuality, laplacianVariance, noiseSigma } from './metrics';

// libvips keeps recently opened files open in its operation cache; on Windows
// that locks the user's photos and their folders. We decode from buffers and
// disable the cache so no file handle outlives a single call.
sharp.cache(false);

export const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff', 'gif', 'avif']);
/** Icons, emoji and UI sprites are not photos; skip anything smaller. */
const MIN_IMAGE_BYTES = 20 * 1024;
/** Common working size for sharpness/noise so images of different resolution are comparable. */
const WORK_SIZE = 512;

export interface ImageScanProgress {
  found: number;
  analyzed: number;
}

export interface ImageScanOptions {
  roots: string[];
  minSimilarity: number;
  signal?: AbortSignal;
  onProgress?: (p: ImageScanProgress) => void;
  concurrency?: number;
  /** Skip files smaller than this (default 20 KB: icons, emoji, UI sprites). */
  minBytes?: number;
}

/** Decode once and measure everything the grouping/scoring needs. Null if undecodable. */
export async function analyzeImage(file: string): Promise<ImageInfo | null> {
  try {
    const [buf, st] = await Promise.all([fs.promises.readFile(file), fs.promises.stat(file)]);
    const meta = await sharp(buf, { failOn: 'none' }).metadata();
    if (!meta.width || !meta.height) return null;
    const rotated = (meta.orientation ?? 1) >= 5;

    const tiny = await sharp(buf, { failOn: 'none' })
      .rotate()
      .greyscale()
      .resize(9, 8, { fit: 'fill' })
      .raw()
      .toBuffer();

    const work = await sharp(buf, { failOn: 'none' })
      .rotate()
      .greyscale()
      .resize(WORK_SIZE, WORK_SIZE, { fit: 'inside', withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const px = new Uint8Array(work.data.buffer, work.data.byteOffset, work.data.length);

    return {
      path: file,
      width: rotated ? meta.height : meta.width,
      height: rotated ? meta.width : meta.height,
      bytes: st.size,
      mtimeMs: st.mtimeMs,
      format: meta.format ?? path.extname(file).slice(1).toLowerCase(),
      hash: hashToHex(dHash(new Uint8Array(tiny.buffer, tiny.byteOffset, tiny.length))),
      sharpness: laplacianVariance(px, work.info.width, work.info.height),
      noise: noiseSigma(px, work.info.width, work.info.height),
      jpegQuality: meta.format === 'jpeg' ? jpegQuality(buf) : null,
      hasExif: !!meta.exif && meta.exif.length > 0,
    };
  } catch {
    return null;
  }
}

/** Run `fn` over `items` with bounded parallelism. */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>, signal?: AbortSignal) {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !signal?.aborted) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/**
 * Finds groups of similar images. Analysis results are cached per file
 * (path + size + mtime) so changing the similarity threshold or rescanning
 * the same folders is fast.
 */
export class ImageScanner {
  private cache = new Map<string, ImageInfo>();
  private analyzed: ImageInfo[] = [];
  private groups: ImageGroup[] = [];

  async scan(opts: ImageScanOptions): Promise<ImageGroup[]> {
    const files: string[] = [];
    const seen = new Set<string>();
    for (const root of opts.roots) {
      for await (const f of walkFiles(root, { signal: opts.signal, skipDirs: SKIP_DIRS })) {
        const ext = path.extname(f.path).slice(1).toLowerCase();
        if (!IMAGE_EXT.has(ext) || f.size < (opts.minBytes ?? MIN_IMAGE_BYTES)) continue;
        const key = f.path.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        files.push(f.path);
        if (files.length % 200 === 0) opts.onProgress?.({ found: files.length, analyzed: 0 });
      }
    }

    const results: ImageInfo[] = [];
    let done = 0;
    await pool(
      files,
      opts.concurrency ?? 4,
      async (file) => {
        const info = await this.analyzeCached(file);
        if (info) results.push(info);
        done++;
        if (done % 10 === 0 || done === files.length) opts.onProgress?.({ found: files.length, analyzed: done });
      },
      opts.signal,
    );
    this.analyzed = results;
    return this.regroup(opts.minSimilarity);
  }

  /** Re-group the last scan with a new threshold, without re-analysing. */
  regroup(minSimilarity: number): ImageGroup[] {
    this.groups = buildGroups(this.analyzed, minSimilarity);
    return this.groups;
  }

  /** Paths that appear in the current groups (others are rejected). */
  filterKnown(paths: string[]): { known: string[]; rejected: string[] } {
    const index = new Map(this.groups.flatMap((g) => g.images.map((i) => [i.path.toLowerCase(), i.path] as const)));
    const known: string[] = [];
    const rejected: string[] = [];
    for (const p of paths) {
      const hit = index.get(p.toLowerCase());
      if (hit) known.push(hit);
      else rejected.push(p);
    }
    return { known, rejected };
  }

  /** Remove deleted files from the cached analysis and groups. */
  forget(paths: string[]): ImageGroup[] {
    const gone = new Set(paths.map((p) => p.toLowerCase()));
    this.analyzed = this.analyzed.filter((i) => !gone.has(i.path.toLowerCase()));
    for (const p of gone) for (const k of this.cache.keys()) if (k.startsWith(p + '|')) this.cache.delete(k);
    this.groups = this.groups
      .map((g) => ({ ...g, images: g.images.filter((i) => !gone.has(i.path.toLowerCase())) }))
      .filter((g) => g.images.length > 1);
    return this.groups;
  }

  /** JPEG data URL preview of an image from the current groups. */
  async preview(file: string, maxSize: number): Promise<string | null> {
    const { known } = this.filterKnown([file]);
    if (!known.length) return null;
    const size = Math.max(64, Math.min(2000, Math.round(maxSize)));
    const buf = await sharp(await fs.promises.readFile(known[0]), { failOn: 'none' })
      .rotate()
      .resize(size, size, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    return 'data:image/jpeg;base64,' + buf.toString('base64');
  }

  private async analyzeCached(file: string): Promise<ImageInfo | null> {
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(file);
    } catch {
      return null;
    }
    const key = `${file.toLowerCase()}|${st.size}|${st.mtimeMs}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const info = await analyzeImage(file);
    if (info) this.cache.set(key, info);
    return info;
  }
}
