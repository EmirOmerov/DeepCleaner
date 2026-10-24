import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { categorize, LargeFileScanner } from '../../src/core/largefiles/largeFiles';

let base: string;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-lf-'));
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

function file(rel: string, bytes: number) {
  const p = path.join(base, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Sparse-ish: write a single byte at the end so large sizes stay cheap.
  const fd = fs.openSync(p, 'w');
  if (bytes > 0) fs.writeSync(fd, Buffer.from([0]), 0, 1, bytes - 1);
  fs.closeSync(fd);
  return p;
}

describe('categorize', () => {
  it.each([
    ['C:\\x\\movie.MKV', 'video'],
    ['C:\\x\\Win11.iso', 'disk-image'],
    ['C:\\x\\disk.vhdx', 'disk-image'],
    ['C:\\x\\backup.7z', 'archive'],
    ['C:\\x\\setup.msi', 'installer'],
    ['C:\\x\\photo.CR2', 'image'],
    ['C:\\x\\noext', 'other'],
  ])('%s -> %s', (p, cat) => expect(categorize(p)).toBe(cat));
});

describe('LargeFileScanner', () => {
  it('returns files above the threshold, largest first', async () => {
    file('a/small.bin', 1000);
    file('a/big.iso', 5000);
    file('b/c/bigger.mp4', 9000);
    const r = await new LargeFileScanner().scan({ roots: [base], minBytes: 4000 });
    expect(r.map((f) => path.basename(f.path))).toEqual(['bigger.mp4', 'big.iso']);
    expect(r[0].category).toBe('video');
    expect(r[0].locked).toBe(false);
  });

  it('respects the limit', async () => {
    for (let i = 1; i <= 5; i++) file(`f${i}.bin`, i * 1000);
    const r = await new LargeFileScanner().scan({ roots: [base], minBytes: 1, limit: 2 });
    expect(r.map((f) => f.size)).toEqual([5000, 4000]);
  });

  it('skips system folder names and AppData', async () => {
    file('Windows/huge.bin', 9000);
    file('AppData/Local/huge.bin', 9000);
    file('Program Files/app/huge.bin', 9000);
    file('Videos/ok.mp4', 9000);
    const r = await new LargeFileScanner().scan({ roots: [base], minBytes: 1 });
    expect(r.map((f) => path.basename(f.path))).toEqual(['ok.mp4']);
  });

  it('does not follow junctions', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-lf-out-'));
    try {
      fs.writeFileSync(path.join(outside, 'elsewhere.bin'), Buffer.alloc(5000));
      fs.symlinkSync(outside, path.join(base, 'link'), 'junction');
      const r = await new LargeFileScanner().scan({ roots: [base], minBytes: 1 });
      expect(r).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('de-duplicates overlapping roots', async () => {
    file('sub/x.iso', 5000);
    const r = await new LargeFileScanner().scan({ roots: [base, path.join(base, 'sub')], minBytes: 1 });
    expect(r).toHaveLength(1);
  });

  it('only accepts removal of paths from the last scan', async () => {
    const big = file('big.iso', 5000);
    const s = new LargeFileScanner();
    await s.scan({ roots: [base], minBytes: 1 });
    const { known, rejected } = s.filterKnown([big.toUpperCase(), 'C:\\Windows\\System32\\kernel32.dll']);
    expect(known).toEqual([big]);
    expect(rejected).toEqual(['C:\\Windows\\System32\\kernel32.dll']);
    s.forget([big]);
    expect(s.filterKnown([big]).known).toEqual([]);
  });

  it('stops when aborted', async () => {
    for (let i = 0; i < 20; i++) file(`d${i}/f.bin`, 10);
    const ac = new AbortController();
    ac.abort();
    const r = await new LargeFileScanner().scan({ roots: [base], minBytes: 1, signal: ac.signal });
    expect(r).toEqual([]);
  });
});
