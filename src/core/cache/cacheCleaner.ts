import * as fs from 'node:fs';
import * as path from 'node:path';
import { describeFsError, walkFiles, type WalkedFile } from '../fsutil';
import type { HistoryLog } from '../quarantine/history';
import type { PathGuard } from '../safety/pathGuard';
import type { CacheTarget } from './cacheTargets';

export interface TargetScan {
  id: string;
  label: string;
  description: string;
  requiresAdmin: boolean;
  lockedBy?: string[];
  /** Existing folders the wildcard roots expanded to. */
  roots: string[];
  files: number;
  bytes: number;
}

export interface TargetCleanResult {
  id: string;
  deleted: number;
  bytes: number;
  skipped: number;
  /** Skip reasons with counts, e.g. { "file is in use": 12 }. */
  skipReasons: Record<string, number>;
}

export interface CleanReport {
  dryRun: boolean;
  targets: TargetCleanResult[];
  bytes: number;
  deleted: number;
  skipped: number;
}

const HOUR_MS = 60 * 60 * 1000;

/** Expand `*` path segments to existing child folders. Links are never followed. */
export async function expandRoot(pattern: string): Promise<string[]> {
  const parts = pattern.split('\\');
  let current = [parts[0]];
  for (const part of parts.slice(1)) {
    const next: string[] = [];
    for (const base of current) {
      if (part === '*') {
        try {
          const entries = await fs.promises.readdir(base + '\\', { withFileTypes: true });
          for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink()) next.push(path.join(base, e.name));
        } catch {
          /* missing or unreadable */
        }
      } else {
        next.push(path.join(base, part));
      }
    }
    current = next;
  }
  const existing: string[] = [];
  for (const p of current) {
    try {
      const st = await fs.promises.lstat(p);
      if (st.isDirectory() && !st.isSymbolicLink()) existing.push(p);
    } catch {
      /* does not exist */
    }
  }
  return existing;
}

export class CacheCleaner {
  constructor(
    private readonly targets: CacheTarget[],
    private readonly guard: PathGuard,
    private readonly history: HistoryLog,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(): CacheTarget[] {
    return this.targets;
  }

  async scan(signal?: AbortSignal): Promise<TargetScan[]> {
    const out: TargetScan[] = [];
    for (const t of this.targets) {
      const { roots, files } = await this.collect(t, signal);
      out.push({
        id: t.id,
        label: t.label,
        description: t.description,
        requiresAdmin: t.requiresAdmin,
        lockedBy: t.lockedBy,
        roots,
        files: files.length,
        bytes: files.reduce((s, f) => s + f.size, 0),
      });
    }
    return out;
  }

  /**
   * Clean the given targets. Only target ids are accepted — file lists are
   * always re-collected here, never taken from the caller.
   */
  async clean(ids: string[], opts: { dryRun?: boolean; signal?: AbortSignal } = {}): Promise<CleanReport> {
    const report: CleanReport = { dryRun: !!opts.dryRun, targets: [], bytes: 0, deleted: 0, skipped: 0 };
    const selected = this.targets.filter((t) => ids.includes(t.id));

    for (const t of selected) {
      const { roots, files } = await this.collect(t, opts.signal);
      const r: TargetCleanResult = { id: t.id, deleted: 0, bytes: 0, skipped: 0, skipReasons: {} };
      const skip = (reason: string) => {
        r.skipped++;
        r.skipReasons[reason] = (r.skipReasons[reason] ?? 0) + 1;
      };

      for (const f of files) {
        if (opts.signal?.aborted) break;
        const check = this.guard.check(f.path, { allowRoots: roots });
        if (!check.ok) {
          skip(check.reason);
          continue;
        }
        if (opts.dryRun) {
          r.deleted++;
          r.bytes += f.size;
          continue;
        }
        try {
          await fs.promises.unlink(check.path);
          r.deleted++;
          r.bytes += f.size;
        } catch (err) {
          skip(describeFsError(err));
        }
      }
      if (!opts.dryRun) for (const root of roots) await this.removeEmptyDirs(root, roots);

      report.targets.push(r);
      report.bytes += r.bytes;
      report.deleted += r.deleted;
      report.skipped += r.skipped;
    }

    if (!opts.dryRun && (report.deleted || report.skipped)) {
      this.history.append({
        action: 'clean',
        module: 'cache',
        items: report.deleted,
        bytes: report.bytes,
        failed: report.skipped,
        sample: selected.map((t) => t.label),
      });
    }
    return report;
  }

  private async collect(t: CacheTarget, signal?: AbortSignal): Promise<{ roots: string[]; files: WalkedFile[] }> {
    const roots = (await Promise.all(t.roots.map(expandRoot))).flat();
    const cutoff = this.now().getTime() - t.minAgeHours * HOUR_MS;
    const files: WalkedFile[] = [];
    for (const root of roots) {
      for await (const f of walkFiles(root, { signal })) {
        if (t.minAgeHours > 0 && f.mtimeMs > cutoff) continue;
        if (t.filePattern && !t.filePattern.test(path.basename(f.path))) continue;
        files.push(f);
      }
    }
    return { roots, files };
  }

  /** Remove now-empty subfolders (deepest first). Roots themselves are kept. */
  private async removeEmptyDirs(root: string, roots: string[]): Promise<void> {
    const dirs: string[] = [];
    const stack = [root];
    while (stack.length) {
      const d = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(d, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isDirectory() && !e.isSymbolicLink()) {
          const full = path.join(d, e.name);
          dirs.push(full);
          stack.push(full);
        }
      }
    }
    dirs.sort((a, b) => b.length - a.length);
    for (const d of dirs) {
      if (!this.guard.check(d, { allowRoots: roots }).ok) continue;
      try {
        await fs.promises.rmdir(d); // fails harmlessly if not empty
      } catch {
        /* not empty or in use */
      }
    }
  }
}
