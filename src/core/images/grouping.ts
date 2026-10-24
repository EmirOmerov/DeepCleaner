import { hamming, hexToHash } from './metrics';

/** Everything measured about one image (produced by analyze.ts). */
export interface ImageInfo {
  path: string;
  width: number;
  height: number;
  bytes: number;
  mtimeMs: number;
  format: string;
  /** 64-bit dHash, 16 hex chars. */
  hash: string;
  /** Laplacian variance at a common working size. */
  sharpness: number;
  /** Noise sigma estimate at the same working size. */
  noise: number;
  /** Estimated JPEG quality (1–100), null for lossless formats. */
  jpegQuality: number | null;
  hasExif: boolean;
}

/** Each metric normalised within its group to 0..1 (1 = best in group). */
export interface ImageMetrics {
  resolution: number;
  sharpness: number;
  quality: number;
  noise: number;
  exif: number;
}

export interface ScoredImage extends ImageInfo {
  score: number;
  isBest: boolean;
  metrics: ImageMetrics;
}

export interface ImageGroup {
  id: string;
  /** Best first. */
  images: ScoredImage[];
  /** 0..1 — similarity of the least similar member to the best one. */
  similarity: number;
  /** Bytes freed by removing every non-best image. */
  reclaimable: number;
}

/** Weights of the quality score. Resolution and sharpness dominate; the rest break ties. */
export const SCORE_WEIGHTS: ImageMetrics = { resolution: 0.35, sharpness: 0.3, quality: 0.15, noise: 0.1, exif: 0.1 };

export function similarityToMaxBits(minSimilarity: number): number {
  return Math.round((1 - Math.min(1, Math.max(0.5, minSimilarity))) * 64);
}

function aspect(i: ImageInfo): number {
  return i.height ? i.width / i.height : 1;
}

/**
 * Group images whose hashes differ by at most the allowed number of bits.
 * Union-find over all pairs; images with clearly different aspect ratios
 * (portrait vs landscape) are never joined.
 */
export function groupSimilar(images: ImageInfo[], minSimilarity = 0.9): ImageInfo[][] {
  const maxBits = similarityToMaxBits(minSimilarity);
  const hashes = images.map((i) => hexToHash(i.hash));
  const parent = images.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (let a = 0; a < images.length; a++) {
    for (let b = a + 1; b < images.length; b++) {
      if (hamming(hashes[a], hashes[b]) > maxBits) continue;
      const ra = aspect(images[a]);
      const rb = aspect(images[b]);
      if (Math.max(ra, rb) / Math.min(ra, rb) > 1.25) continue;
      parent[find(a)] = find(b);
    }
  }
  const groups = new Map<number, ImageInfo[]>();
  images.forEach((img, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), img]);
  });
  return [...groups.values()].filter((g) => g.length > 1);
}

/** Score every image relative to the others in its group and mark the best one. */
export function scoreGroup(group: ImageInfo[]): ScoredImage[] {
  const mp = (i: ImageInfo) => i.width * i.height;
  const maxMp = Math.max(...group.map(mp)) || 1;
  const maxSharp = Math.max(...group.map((i) => i.sharpness));
  const positiveNoise = group.map((i) => i.noise).filter((n) => n > 0);
  const minNoise = positiveNoise.length ? Math.min(...positiveNoise) : 0;
  const anyExif = group.some((i) => i.hasExif);

  const scored: ScoredImage[] = group.map((i) => {
    const metrics: ImageMetrics = {
      resolution: mp(i) / maxMp,
      sharpness: maxSharp > 0 ? i.sharpness / maxSharp : 1,
      quality: (i.jpegQuality ?? 100) / 100,
      noise: i.noise > 0 && minNoise > 0 ? minNoise / i.noise : 1,
      exif: anyExif ? (i.hasExif ? 1 : 0) : 1,
    };
    const score = (Object.keys(SCORE_WEIGHTS) as Array<keyof ImageMetrics>).reduce(
      (s, k) => s + SCORE_WEIGHTS[k] * metrics[k],
      0,
    );
    return { ...i, metrics, score, isBest: false };
  });

  // Ties (exact duplicates): keep the larger file, then the older one (likely the original).
  scored.sort((a, b) => b.score - a.score || b.bytes - a.bytes || a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  scored[0].isBest = true;
  return scored;
}

/** Group, score, and order groups by how much space they free. */
export function buildGroups(images: ImageInfo[], minSimilarity = 0.9): ImageGroup[] {
  return groupSimilar(images, minSimilarity)
    .map((g) => {
      const scored = scoreGroup(g);
      const best = hexToHash(scored[0].hash);
      const worst = Math.max(...scored.slice(1).map((s) => hamming(best, hexToHash(s.hash))));
      return {
        id: scored[0].path.toLowerCase(),
        images: scored,
        similarity: 1 - worst / 64,
        reclaimable: scored.slice(1).reduce((s, i) => s + i.bytes, 0),
      };
    })
    .sort((a, b) => b.reclaimable - a.reclaimable);
}
