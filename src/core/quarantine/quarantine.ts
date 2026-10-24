import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describeFsError, pathSize } from '../fsutil';
import type { PathGuard } from '../safety/pathGuard';
import { normalizePath } from '../safety/pathGuard';
import type { HistoryLog } from './history';

export interface QuarantineItem {
  id: string;
  originalPath: string;
  storedPath: string;
  isDirectory: boolean;
  bytes: number;
  module: string;
  quarantinedAt: string;
  expiresAt: string;
}

export interface OpSuccess {
  path: string;
  bytes: number;
  id?: string;
  restoredTo?: string;
}

export interface OpFailure {
  path: string;
  reason: string;
}

export interface OpResult {
  done: OpSuccess[];
  failed: OpFailure[];
  bytes: number;
}

interface Manifest {
  version: 1;
  items: QuarantineItem[];
}

export interface QuarantineOptions {
  vaultDir: string;
  guard: PathGuard;
  history: HistoryLog;
  retentionDays?: number;
  now?: () => Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Reversible deletion. Items are moved (not copied) into a vault and tracked
 * in a manifest; they can be restored until they expire and are purged.
 * Every input path passes the PathGuard first.
 */
export class Quarantine {
  private readonly manifestFile: string;
  private readonly itemsDir: string;
  private readonly retentionDays: number;
  private readonly now: () => Date;

  constructor(private readonly opts: QuarantineOptions) {
    this.manifestFile = path.join(opts.vaultDir, 'manifest.json');
    this.itemsDir = path.join(opts.vaultDir, 'items');
    this.retentionDays = opts.retentionDays ?? 30;
    this.now = opts.now ?? (() => new Date());
  }

  list(): QuarantineItem[] {
    return [...this.load().items].sort((a, b) => b.quarantinedAt.localeCompare(a.quarantinedAt));
  }

  /** Move items into the vault. */
  async quarantine(paths: string[], module: string): Promise<OpResult> {
    const result = emptyResult();
    const manifest = this.load();
    for (const input of paths) {
      const checked = this.checkTarget(input);
      if (!checked.ok) {
        result.failed.push({ path: input, reason: checked.reason });
        continue;
      }
      const src = checked.path;
      try {
        const st = await fs.promises.lstat(src);
        const bytes = await pathSize(src);
        const id = newId(this.now());
        const storedPath = path.join(this.itemsDir, id, path.basename(src));
        await fs.promises.mkdir(path.dirname(storedPath), { recursive: true });
        await moveAcrossVolumes(src, storedPath);
        const at = this.now();
        manifest.items.push({
          id,
          originalPath: src,
          storedPath,
          isDirectory: st.isDirectory(),
          bytes,
          module,
          quarantinedAt: at.toISOString(),
          expiresAt: new Date(at.getTime() + this.retentionDays * DAY_MS).toISOString(),
        });
        this.save(manifest);
        result.done.push({ path: src, bytes, id });
        result.bytes += bytes;
      } catch (err) {
        result.failed.push({ path: src, reason: describeFsError(err) });
      }
    }
    this.log('quarantine', module, result);
    return result;
  }

  /** Put items back. If the original path is taken, restore next to it with a suffix. */
  async restore(ids: string[]): Promise<OpResult> {
    const result = emptyResult();
    const manifest = this.load();
    for (const id of ids) {
      const item = manifest.items.find((i) => i.id === id);
      if (!item) {
        result.failed.push({ path: id, reason: 'not found in quarantine' });
        continue;
      }
      try {
        const dest = await freeName(item.originalPath);
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        await moveAcrossVolumes(item.storedPath, dest);
        await fs.promises.rm(path.dirname(item.storedPath), { recursive: true, force: true });
        manifest.items = manifest.items.filter((i) => i.id !== id);
        this.save(manifest);
        result.done.push({ path: item.originalPath, bytes: item.bytes, id, restoredTo: dest });
        result.bytes += item.bytes;
      } catch (err) {
        result.failed.push({ path: item.originalPath, reason: describeFsError(err) });
      }
    }
    this.log('restore', 'quarantine', result);
    return result;
  }

  /** Permanently remove items from the vault (user chose "empty"). */
  async remove(ids: string[]): Promise<OpResult> {
    return this.dropItems(this.load().items.filter((i) => ids.includes(i.id)), 'delete');
  }

  /** Remove items past their retention period. */
  async purgeExpired(opts: { dryRun?: boolean } = {}): Promise<OpResult> {
    const nowMs = this.now().getTime();
    const expired = this.load().items.filter((i) => Date.parse(i.expiresAt) <= nowMs);
    if (opts.dryRun) {
      return {
        done: expired.map((i) => ({ path: i.originalPath, bytes: i.bytes, id: i.id })),
        failed: [],
        bytes: expired.reduce((s, i) => s + i.bytes, 0),
      };
    }
    return this.dropItems(expired, 'purge');
  }

  /** Irreversible delete, for regenerable data such as caches. Still guarded and logged. */
  async deletePermanently(paths: string[], module: string, allowRoots?: string[]): Promise<OpResult> {
    const result = emptyResult();
    for (const input of paths) {
      const checked = this.checkTarget(input, allowRoots);
      if (!checked.ok) {
        result.failed.push({ path: input, reason: checked.reason });
        continue;
      }
      try {
        const bytes = await pathSize(checked.path);
        await fs.promises.rm(checked.path, { recursive: true });
        result.done.push({ path: checked.path, bytes });
        result.bytes += bytes;
      } catch (err) {
        result.failed.push({ path: checked.path, reason: describeFsError(err) });
      }
    }
    this.log('delete', module, result);
    return result;
  }

  private async dropItems(items: QuarantineItem[], action: 'delete' | 'purge'): Promise<OpResult> {
    const result = emptyResult();
    const manifest = this.load();
    for (const item of items) {
      try {
        await fs.promises.rm(path.dirname(item.storedPath), { recursive: true, force: true });
        manifest.items = manifest.items.filter((i) => i.id !== item.id);
        result.done.push({ path: item.originalPath, bytes: item.bytes, id: item.id });
        result.bytes += item.bytes;
      } catch (err) {
        result.failed.push({ path: item.originalPath, reason: describeFsError(err) });
      }
    }
    this.save(manifest);
    if (items.length) this.log(action, 'quarantine', result);
    return result;
  }

  private checkTarget(input: string, allowRoots?: string[]) {
    const r = this.opts.guard.check(input, allowRoots ? { allowRoots } : undefined);
    if (!r.ok) return r;
    const vault = normalizePath(this.opts.vaultDir).toLowerCase();
    const target = r.path.toLowerCase();
    if (target === vault || target.startsWith(vault + '\\') || vault.startsWith(target + '\\')) {
      return { ok: false as const, path: r.path, reason: 'cannot touch the quarantine vault' };
    }
    return r;
  }

  private load(): Manifest {
    try {
      const m = JSON.parse(fs.readFileSync(this.manifestFile, 'utf8')) as Manifest;
      return m.version === 1 && Array.isArray(m.items) ? m : { version: 1, items: [] };
    } catch {
      return { version: 1, items: [] };
    }
  }

  /** Atomic write: temp file + rename, so a crash never leaves a half-written manifest. */
  private save(m: Manifest): void {
    fs.mkdirSync(this.opts.vaultDir, { recursive: true });
    const tmp = this.manifestFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2), 'utf8');
    fs.renameSync(tmp, this.manifestFile);
  }

  private log(action: 'quarantine' | 'restore' | 'delete' | 'purge', module: string, r: OpResult) {
    if (!r.done.length && !r.failed.length) return;
    this.opts.history.append({
      action,
      module,
      items: r.done.length,
      bytes: r.bytes,
      failed: r.failed.length,
      sample: r.done.slice(0, 5).map((d) => d.path),
    });
  }
}

function emptyResult(): OpResult {
  return { done: [], failed: [], bytes: 0 };
}

function newId(d: Date): string {
  return `${d.getTime().toString(36)}-${randomBytes(4).toString('hex')}`;
}

/** rename(), falling back to copy+delete across volumes. Rolls back the copy if the source can't be removed. */
async function moveAcrossVolumes(src: string, dest: string): Promise<void> {
  try {
    await fs.promises.rename(src, dest);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
  }
  await fs.promises.cp(src, dest, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  try {
    await fs.promises.rm(src, { recursive: true });
  } catch (err) {
    await fs.promises.rm(dest, { recursive: true, force: true });
    throw err;
  }
}

/** First non-existing variant of `p`: "name (restored).ext", "name (restored 2).ext", ... */
async function freeName(p: string): Promise<string> {
  if (!fs.existsSync(p)) return p;
  const dir = path.dirname(p);
  const ext = path.extname(p);
  const stem = path.basename(p, ext);
  for (let n = 1; ; n++) {
    const candidate = path.join(dir, `${stem} (restored${n > 1 ? ' ' + n : ''})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}
