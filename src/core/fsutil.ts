import * as fs from 'node:fs';
import * as path from 'node:path';

export interface WalkedFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface WalkOptions {
  /** Stop descending after this many levels (0 = only the root's direct children). */
  maxDepth?: number;
  /** Abort signal for long scans. */
  signal?: AbortSignal;
  /** Directory names (lowercase) to skip entirely. */
  skipDirs?: Set<string>;
}

/**
 * Walk regular files beneath `root`. Symlinks and junctions are never followed
 * and never yielded, so a scan can't escape the root or report linked targets.
 * Unreadable directories are skipped silently.
 */
export async function* walkFiles(root: string, opts: WalkOptions = {}): AsyncGenerator<WalkedFile> {
  const maxDepth = opts.maxDepth ?? Infinity;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length) {
    if (opts.signal?.aborted) return;
    const { dir, depth } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth && !opts.skipDirs?.has(e.name.toLowerCase())) {
          stack.push({ dir: full, depth: depth + 1 });
        }
      } else if (e.isFile()) {
        try {
          const st = await fs.promises.lstat(full);
          yield { path: full, size: st.size, mtimeMs: st.mtimeMs };
        } catch {
          /* vanished or inaccessible */
        }
      }
    }
  }
}

/** Total bytes of a file or directory tree (links not followed). */
export async function pathSize(p: string): Promise<number> {
  const st = await fs.promises.lstat(p);
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for await (const f of walkFiles(p)) total += f.size;
  return total;
}

/** Human-readable reason for common Windows file errors. */
export function describeFsError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  switch (code) {
    case 'EBUSY':
      return 'file is in use';
    case 'EPERM':
    case 'EACCES':
      return 'access denied (in use or needs administrator)';
    case 'ENOENT':
      return 'no longer exists';
    case 'ENOTEMPTY':
      return 'folder not empty';
    default:
      return (err as Error)?.message ?? String(err);
  }
}
