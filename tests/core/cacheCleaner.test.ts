import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CacheCleaner, expandRoot } from '../../src/core/cache/cacheCleaner';
import type { CacheTarget } from '../../src/core/cache/cacheTargets';
import { defaultCacheTargets } from '../../src/core/cache/cacheTargets';
import { HistoryLog } from '../../src/core/quarantine/history';
import { createPathGuard, defaultGuardConfig } from '../../src/core/safety/pathGuard';

const NOW = new Date('2026-06-01T12:00:00Z');
const OLD = new Date('2026-05-01T12:00:00Z');

let base: string;
let history: HistoryLog;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-cache-'));
  history = new HistoryLog(path.join(base, 'history.jsonl'));
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

function file(rel: string, bytes: number, mtime: Date = OLD) {
  const p = path.join(base, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes));
  fs.utimesSync(p, mtime, mtime);
  return p;
}

function cleaner(targets: CacheTarget[]) {
  const guard = createPathGuard(defaultGuardConfig({ SystemDrive: 'C:', USERPROFILE: 'C:\\Users\\nobody' }));
  return new CacheCleaner(targets, guard, history, () => NOW);
}

const target = (over: Partial<CacheTarget> = {}): CacheTarget => ({
  id: 't',
  label: 'Test',
  description: '',
  roots: [path.join(base, 'cache')],
  minAgeHours: 24,
  requiresAdmin: false,
  ...over,
});

describe('CacheCleaner', () => {
  it('scans only files older than minAge', async () => {
    file('cache/old.tmp', 100);
    file('cache/sub/old2.tmp', 50);
    file('cache/fresh.tmp', 999, NOW);
    const [scan] = await cleaner([target()]).scan();
    expect(scan.files).toBe(2);
    expect(scan.bytes).toBe(150);
  });

  it('dry run deletes nothing', async () => {
    const f = file('cache/old.tmp', 100);
    const report = await cleaner([target()]).clean(['t'], { dryRun: true });
    expect(report.bytes).toBe(100);
    expect(fs.existsSync(f)).toBe(true);
    expect(history.read()).toEqual([]);
  });

  it('deletes old files, keeps fresh ones, prunes empty folders but keeps the root', async () => {
    file('cache/old.tmp', 100);
    file('cache/a/b/old.tmp', 10);
    const fresh = file('cache/fresh.tmp', 5, NOW);
    const report = await cleaner([target()]).clean(['t']);
    expect(report.deleted).toBe(2);
    expect(report.bytes).toBe(110);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(path.join(base, 'cache', 'a'))).toBe(false);
    expect(fs.existsSync(path.join(base, 'cache'))).toBe(true);
    expect(history.read()[0]).toMatchObject({ action: 'clean', module: 'cache', items: 2, bytes: 110 });
  });

  it('respects filePattern', async () => {
    const keep = file('cache/important.db', 10);
    file('cache/thumbcache_256.db', 10);
    const report = await cleaner([target({ filePattern: /^thumbcache_.*\.db$/i, minAgeHours: 0 })]).clean(['t']);
    expect(report.deleted).toBe(1);
    expect(fs.existsSync(keep)).toBe(true);
  });

  it('never deletes through a junction inside the cache folder', async () => {
    const precious = file('outside/precious.jpg', 10);
    file('cache/x.tmp', 10);
    fs.symlinkSync(path.join(base, 'outside'), path.join(base, 'cache', 'link'), 'junction');
    await cleaner([target({ minAgeHours: 0 })]).clean(['t']);
    expect(fs.existsSync(precious)).toBe(true);
  });

  it('expands * to every profile folder', async () => {
    file('ud/Default/Cache/a', 1);
    file('ud/Profile 1/Cache/b', 1);
    file('ud/Default/Preferences', 1);
    const roots = await expandRoot(path.join(base, 'ud', '*', 'Cache'));
    expect(roots.map((r) => path.basename(path.dirname(r))).sort()).toEqual(['Default', 'Profile 1']);
    const report = await cleaner([target({ roots: [path.join(base, 'ud', '*', 'Cache')], minAgeHours: 0 })]).clean(['t']);
    expect(report.deleted).toBe(2);
    expect(fs.existsSync(path.join(base, 'ud', 'Default', 'Preferences'))).toBe(true);
  });

  it('ignores unknown target ids', async () => {
    const f = file('cache/old.tmp', 1);
    const report = await cleaner([target()]).clean(['does-not-exist']);
    expect(report.targets).toEqual([]);
    expect(fs.existsSync(f)).toBe(true);
  });
});

describe('default cache targets', () => {
  const env = {
    SystemDrive: 'C:',
    SystemRoot: 'C:\\Windows',
    ProgramData: 'C:\\ProgramData',
    USERPROFILE: 'C:\\Users\\emir',
    LOCALAPPDATA: 'C:\\Users\\emir\\AppData\\Local',
    TEMP: 'C:\\Users\\emir\\AppData\\Local\\Temp',
  };
  const guard = createPathGuard({ ...defaultGuardConfig(env), realpath: (p) => p });

  it('every whitelisted root allows its contents through PathGuard', () => {
    for (const t of defaultCacheTargets(env)) {
      for (const root of t.roots) {
        const sample = root.replace('*', 'Default') + '\\file.bin';
        expect(guard.check(sample).ok, `${t.id}: ${sample}`).toBe(true);
      }
    }
  });

  it('never targets a protected system folder', () => {
    const all = defaultCacheTargets(env).flatMap((t) => t.roots).join('|').toLowerCase();
    for (const bad of ['system32', 'winsxs', 'driverstore', '\\fonts', 'syswow64', 'ntuser']) {
      expect(all).not.toContain(bad);
    }
  });
});
