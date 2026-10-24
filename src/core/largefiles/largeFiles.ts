import * as fs from 'node:fs';
import * as path from 'node:path';
import { walkFiles } from '../fsutil';

export type FileCategory = 'video' | 'archive' | 'disk-image' | 'document' | 'image' | 'audio' | 'installer' | 'other';

export interface LargeFile {
  path: string;
  size: number;
  mtimeMs: number;
  category: FileCategory;
  /** Opened exclusively by another process (e.g. a running VM disk). */
  locked: boolean;
}

export interface ScanProgress {
  scannedFiles: number;
  found: number;
  currentRoot: string;
}

export interface LargeFileScanOptions {
  roots: string[];
  minBytes: number;
  /** Keep only the N largest results. */
  limit?: number;
  signal?: AbortSignal;
  onProgress?: (p: ScanProgress) => void;
}

const CATEGORY_EXT: Record<Exclude<FileCategory, 'other'>, string[]> = {
  video: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'm4v', 'mpg', 'mpeg', 'flv', 'ts'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'cab', 'zst'],
  'disk-image': ['iso', 'img', 'vhd', 'vhdx', 'vmdk', 'vdi', 'qcow2', 'wim', 'esd'],
  document: ['pdf', 'docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls', 'psd', 'ai', 'indd', 'blend', 'dwg'],
  image: ['jpg', 'jpeg', 'png', 'tif', 'tiff', 'raw', 'cr2', 'nef', 'arw', 'dng', 'heic', 'bmp', 'gif', 'webp'],
  audio: ['wav', 'flac', 'mp3', 'aac', 'm4a', 'ogg', 'aiff'],
  installer: ['exe', 'msi', 'msix', 'appx', 'apk', 'dmg'],
};
const EXT_TO_CATEGORY = new Map<string, FileCategory>(
  Object.entries(CATEGORY_EXT).flatMap(([cat, exts]) => exts.map((e) => [e, cat as FileCategory])),
);

export function categorize(filePath: string): FileCategory {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return EXT_TO_CATEGORY.get(ext) ?? 'other';
}

/** Folder names never descended into while looking for large files. */
export const SKIP_DIRS = new Set([
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  '$recycle.bin',
  'system volume information',
  'recovery',
  '$windows.~bt',
  '$windows.~ws',
  'windows.old',
  'appdata',
  'windowsapps',
]);

/**
 * Default places to look: the user's profile on the system drive, and the
 * whole of every other fixed drive (system folders excluded via SKIP_DIRS).
 */
export function defaultScanRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const systemDrive = (env.SystemDrive || 'C:').toUpperCase();
  const roots: string[] = [];
  if (env.USERPROFILE) roots.push(env.USERPROFILE);
  for (let c = 'C'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
    const drive = String.fromCharCode(c) + ':';
    if (drive === systemDrive) continue;
    try {
      fs.accessSync(drive + '\\');
      roots.push(drive + '\\');
    } catch {
      /* no such drive */
    }
  }
  return roots;
}

/** True if another process holds the file open without sharing. */
export async function isLocked(filePath: string): Promise<boolean> {
  try {
    const fh = await fs.promises.open(filePath, 'r');
    await fh.close();
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
  }
}

/**
 * Finds the largest files under the given roots. Holds on to the result so
 * callers can verify that a path asked to be removed actually came from the
 * last scan — the renderer can't inject arbitrary paths.
 */
export class LargeFileScanner {
  private last = new Map<string, LargeFile>();

  async scan(opts: LargeFileScanOptions): Promise<LargeFile[]> {
    const limit = opts.limit ?? 500;
    const found: Array<{ path: string; size: number; mtimeMs: number }> = [];
    let scanned = 0;
    const seenRoots = new Set<string>();

    for (const root of opts.roots) {
      const rootKey = path.resolve(root).toLowerCase();
      if (seenRoots.has(rootKey)) continue;
      seenRoots.add(rootKey);
      for await (const f of walkFiles(root, { signal: opts.signal, skipDirs: SKIP_DIRS })) {
        scanned++;
        if (f.size >= opts.minBytes) found.push(f);
        if (scanned % 2000 === 0) opts.onProgress?.({ scannedFiles: scanned, found: found.length, currentRoot: root });
      }
      if (opts.signal?.aborted) break;
    }
    opts.onProgress?.({ scannedFiles: scanned, found: found.length, currentRoot: '' });

    // Overlapping roots (e.g. a folder inside the profile) can yield duplicates.
    const unique = [...new Map(found.map((f) => [f.path.toLowerCase(), f])).values()];
    unique.sort((a, b) => b.size - a.size);
    const top = unique.slice(0, limit);

    const results: LargeFile[] = [];
    for (const f of top) {
      results.push({ ...f, category: categorize(f.path), locked: await isLocked(f.path) });
    }
    this.last = new Map(results.map((r) => [r.path.toLowerCase(), r]));
    return results;
  }

  /** Keep only paths that appeared in the most recent scan and aren't locked. */
  filterKnown(paths: string[]): { known: string[]; rejected: string[] } {
    const known: string[] = [];
    const rejected: string[] = [];
    for (const p of paths) {
      const hit = this.last.get(p.toLowerCase());
      if (hit && !hit.locked) known.push(hit.path);
      else rejected.push(p);
    }
    return { known, rejected };
  }

  /** Look up a path from the last scan (locked files included). */
  find(p: string): LargeFile | undefined {
    return this.last.get(p.toLowerCase());
  }

  /** Drop removed paths so they can't be acted on twice. */
  forget(paths: string[]): void {
    for (const p of paths) this.last.delete(p.toLowerCase());
  }
}
