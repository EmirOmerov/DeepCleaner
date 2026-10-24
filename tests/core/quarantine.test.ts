import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HistoryLog } from '../../src/core/quarantine/history';
import { Quarantine } from '../../src/core/quarantine/quarantine';
import { createPathGuard, defaultGuardConfig } from '../../src/core/safety/pathGuard';

const fakeEnv = {
  SystemDrive: 'C:',
  SystemRoot: 'C:\\Windows',
  USERPROFILE: 'C:\\Users\\nobody',
  ProgramData: 'C:\\ProgramData',
  ProgramFiles: 'C:\\Program Files',
};

let base: string;
let work: string;
let vault: string;
let clock: Date;
let history: HistoryLog;
let q: Quarantine;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-q-'));
  work = path.join(base, 'work');
  vault = path.join(base, 'vault');
  fs.mkdirSync(work);
  clock = new Date('2026-01-01T00:00:00Z');
  history = new HistoryLog(path.join(base, 'history.jsonl'));
  q = new Quarantine({
    vaultDir: vault,
    guard: createPathGuard(defaultGuardConfig(fakeEnv)),
    history,
    now: () => clock,
  });
});

afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

function write(rel: string, content = 'data') {
  const p = path.join(work, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

describe('Quarantine', () => {
  it('moves a file out and restores it intact', async () => {
    const f = write('a.txt', 'hello');
    const r = await q.quarantine([f], 'largefiles');
    expect(r.failed).toEqual([]);
    expect(fs.existsSync(f)).toBe(false);
    expect(q.list()).toHaveLength(1);
    expect(q.list()[0].bytes).toBe(5);

    const back = await q.restore([r.done[0].id!]);
    expect(back.failed).toEqual([]);
    expect(fs.readFileSync(f, 'utf8')).toBe('hello');
    expect(q.list()).toHaveLength(0);
  });

  it('quarantines whole folders', async () => {
    write('dir/x.bin', '12345');
    write('dir/sub/y.bin', '123');
    const r = await q.quarantine([path.join(work, 'dir')], 'uninstall');
    expect(r.bytes).toBe(8);
    expect(fs.existsSync(path.join(work, 'dir'))).toBe(false);
    await q.restore([r.done[0].id!]);
    expect(fs.readFileSync(path.join(work, 'dir', 'sub', 'y.bin'), 'utf8')).toBe('123');
  });

  it('restores next to the original when the path is taken', async () => {
    const f = write('photo.jpg', 'old');
    const r = await q.quarantine([f], 'images');
    write('photo.jpg', 'new');
    const back = await q.restore([r.done[0].id!]);
    expect(back.done[0].restoredTo).toBe(path.join(work, 'photo (restored).jpg'));
    expect(fs.readFileSync(f, 'utf8')).toBe('new');
    expect(fs.readFileSync(path.join(work, 'photo (restored).jpg'), 'utf8')).toBe('old');
  });

  it('refuses protected paths and touches nothing', async () => {
    const r = await q.quarantine(['C:\\Windows\\System32\\kernel32.dll', 'C:\\pagefile.sys', 'C:\\'], 'x');
    expect(r.done).toEqual([]);
    expect(r.failed).toHaveLength(3);
    expect(q.list()).toEqual([]);
  });

  it('refuses to quarantine the vault itself', async () => {
    write('a.txt');
    await q.quarantine([path.join(work, 'a.txt')], 'x');
    const r = await q.quarantine([vault, path.join(vault, 'manifest.json')], 'x');
    expect(r.done).toEqual([]);
    expect(fs.existsSync(path.join(vault, 'manifest.json'))).toBe(true);
  });

  it('reports missing files without throwing', async () => {
    const r = await q.quarantine([path.join(work, 'nope.txt')], 'x');
    expect(r.failed[0].reason).toMatch(/no longer exists/);
  });

  it('purge dry-run deletes nothing; real purge only removes expired items', async () => {
    const old = await q.quarantine([write('old.txt')], 'x');
    clock = new Date('2026-01-20T00:00:00Z');
    await q.quarantine([write('new.txt')], 'x');
    clock = new Date('2026-02-01T00:00:00Z'); // 31 days after the first, 12 after the second

    const dry = await q.purgeExpired({ dryRun: true });
    expect(dry.done.map((d) => d.id)).toEqual([old.done[0].id]);
    expect(q.list()).toHaveLength(2);

    const real = await q.purgeExpired();
    expect(real.done).toHaveLength(1);
    expect(q.list().map((i) => path.basename(i.originalPath))).toEqual(['new.txt']);
  });

  it('logs every action to history', async () => {
    const r = await q.quarantine([write('a.txt')], 'cache');
    await q.restore([r.done[0].id!]);
    const h = history.read();
    expect(h.map((e) => e.action)).toEqual(['restore', 'quarantine']);
    expect(h[1].module).toBe('cache');
  });
});

describe('registry quarantine', () => {
  /** Fake registry: a set of keys; export writes the key name into the .reg file. */
  function fakeRegistry(keys: Set<string>, opts: { failDelete?: boolean } = {}) {
    return {
      exportKey: async (key: string, file: string) => fs.writeFileSync(file, key),
      deleteKey: async (key: string) => {
        if (opts.failDelete) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        keys.delete(key);
      },
      importFile: async (file: string) => void keys.add(fs.readFileSync(file, 'utf8')),
    };
  }
  const guard = () => createPathGuard(defaultGuardConfig(fakeEnv));

  it('backs up, deletes and restores a key', async () => {
    const keys = new Set(['HKCU\\Software\\VideoLAN\\VLC']);
    const rq = new Quarantine({ vaultDir: vault, guard: guard(), history, registry: fakeRegistry(keys) });
    const r = await rq.quarantineRegistry(['HKCU\\Software\\VideoLAN\\VLC'], 'uninstall');
    expect(r.failed).toEqual([]);
    expect(keys.size).toBe(0);
    expect(rq.list()[0]).toMatchObject({ kind: 'registry', originalPath: 'HKCU\\Software\\VideoLAN\\VLC' });
    await rq.restore([r.done[0].id!]);
    expect(keys.has('HKCU\\Software\\VideoLAN\\VLC')).toBe(true);
    expect(rq.list()).toEqual([]);
  });

  it('refuses protected keys without touching the registry', async () => {
    const keys = new Set(['HKLM\\SOFTWARE\\Microsoft']);
    const rq = new Quarantine({ vaultDir: vault, guard: guard(), history, registry: fakeRegistry(keys) });
    const r = await rq.quarantineRegistry(['HKLM\\SOFTWARE\\Microsoft', 'HKCU\\Software'], 'uninstall');
    expect(r.done).toEqual([]);
    expect(keys.size).toBe(1);
  });

  it('discards the backup when the delete fails', async () => {
    const keys = new Set(['HKLM\\Software\\Vendor\\App']);
    const rq = new Quarantine({ vaultDir: vault, guard: guard(), history, registry: fakeRegistry(keys, { failDelete: true }) });
    const r = await rq.quarantineRegistry(['HKLM\\Software\\Vendor\\App'], 'uninstall');
    expect(r.failed[0].reason).toMatch(/access denied/);
    expect(rq.list()).toEqual([]);
    expect(keys.size).toBe(1);
  });
});

describe('deletePermanently', () => {
  it('does not follow junctions inside a deleted folder', async () => {
    const outside = path.join(base, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep me');
    write('trash/junk.tmp');
    fs.symlinkSync(outside, path.join(work, 'trash', 'link'), 'junction');

    const r = await q.deletePermanently([path.join(work, 'trash')], 'cache');
    expect(r.failed).toEqual([]);
    expect(fs.existsSync(path.join(work, 'trash'))).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep me');
  });

  it('enforces allowRoots', async () => {
    const f = write('a.tmp');
    const r = await q.deletePermanently([f], 'cache', [path.join(base, 'somewhere-else')]);
    expect(r.done).toEqual([]);
    expect(fs.existsSync(f)).toBe(true);
  });
});
