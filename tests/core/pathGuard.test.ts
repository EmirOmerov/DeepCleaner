import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createPathGuard,
  defaultGuardConfig,
  defaultRealpath,
  normalizePath,
} from '../../src/core/safety/pathGuard';

const env = {
  SystemDrive: 'C:',
  SystemRoot: 'C:\\Windows',
  ProgramData: 'C:\\ProgramData',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  USERPROFILE: 'C:\\Users\\emir',
  APPDATA: 'C:\\Users\\emir\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\emir\\AppData\\Local',
  TEMP: 'C:\\Users\\emir\\AppData\\Local\\Temp',
};

/** Pretend every path exists as written, except unresolvable short names and explicit links. */
function fakeGuard(links: Record<string, string> = {}) {
  const cfg = defaultGuardConfig(env);
  cfg.realpath = (p) => {
    const hit = Object.keys(links).find((l) => p.toLowerCase().startsWith(l.toLowerCase()));
    if (hit) return links[hit] + p.slice(hit.length);
    return /~\d/.test(p) ? null : p;
  };
  return createPathGuard(cfg);
}

describe('normalizePath', () => {
  it.each([
    ['C:/Windows/System32', 'C:\\Windows\\System32'],
    ['\\\\?\\C:\\Windows\\', 'C:\\Windows'],
    ['C:\\Temp\\..\\Windows\\.\\System32', 'C:\\Windows\\System32'],
    ['C:\\Windows. \\System32', 'C:\\Windows\\System32'],
    ['C:\\', 'C:\\'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
  });
});

describe('PathGuard refuses protected targets', () => {
  const guard = fakeGuard();
  it.each([
    'C:\\',
    'c:',
    'C:\\Windows',
    'C:\\Windows\\System32',
    'c:\\WINDOWS\\system32\\drivers\\etc\\hosts',
    'C:\\Windows\\WinSxS\\amd64_foo',
    'C:\\Windows\\System32\\DriverStore\\FileRepository',
    'C:\\Windows\\Fonts\\arial.ttf',
    'C:\\Users\\emir\\AppData\\Local\\Temp\\..\\..\\..\\..\\..\\Windows\\System32',
    'C:\\Windows\\Temp\\..\\System32\\kernel32.dll',
    'C:\\Windows\\Temp',
    'C:\\Windows\\SoftwareDistribution\\DataStore\\DataStore.edb',
    'C:\\pagefile.sys',
    'D:\\hiberfil.sys',
    'C:\\Users\\emir\\NTUSER.DAT',
    'C:\\Users\\emir\\ntuser.dat.LOG1',
    'C:\\Users\\emir\\AppData\\Local\\Microsoft\\Windows\\UsrClass.dat',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'C:\\ProgramData',
    'C:\\ProgramData\\Microsoft\\Windows\\Start Menu',
    'C:\\Users',
    'C:\\Users\\emir',
    'C:\\Users\\emir\\Documents',
    'C:\\Users\\emir\\AppData\\Local',
    'C:\\Users\\emir\\AppData\\Local\\Temp',
    'C:\\System Volume Information\\x',
    'C:\\$Recycle.Bin\\S-1-5',
    'C:\\Program Files\\WindowsApps\\Microsoft.Foo',
    'C:\\PROGRA~1\\Adobe',
    'C:\\Users\\emir\\file.txt:hidden',
    'relative\\path',
    '\\\\server\\share\\file',
    '',
    '   ',
  ])('refuses %j', (target) => {
    expect(guard.check(target).ok).toBe(false);
  });
});

describe('PathGuard allows ordinary targets', () => {
  const guard = fakeGuard();
  it.each([
    'C:\\Windows\\Temp\\setup.log',
    'C:\\Windows\\SoftwareDistribution\\Download\\abc\\x.cab',
    'C:\\ProgramData\\Microsoft\\Windows\\WER\\ReportArchive\\AppCrash_1',
    'C:\\Users\\emir\\AppData\\Local\\Temp\\tmp123.tmp',
    'C:\\Users\\emir\\Downloads\\Win11.iso',
    'C:\\Program Files\\Adobe\\Acrobat DC',
    'D:\\Videos\\big.mp4',
  ])('allows %j', (target) => {
    expect(guard.check(target).ok).toBe(true);
  });
});

describe('PathGuard whitelist mode (allowRoots)', () => {
  const guard = fakeGuard();
  const roots = ['C:\\Users\\emir\\AppData\\Local\\Temp'];
  it('allows files strictly inside a root', () => {
    expect(guard.check('C:\\Users\\emir\\AppData\\Local\\Temp\\a\\b.tmp', { allowRoots: roots }).ok).toBe(true);
  });
  it('refuses the root itself', () => {
    expect(guard.check('C:\\Users\\emir\\AppData\\Local\\Temp', { allowRoots: roots }).ok).toBe(false);
  });
  it('refuses lookalike siblings', () => {
    expect(guard.check('C:\\Users\\emir\\AppData\\Local\\Temp2\\x', { allowRoots: roots }).ok).toBe(false);
  });
  it('refuses traversal out of the root', () => {
    expect(guard.check('C:\\Users\\emir\\AppData\\Local\\Temp\\..\\Google\\x', { allowRoots: roots }).ok).toBe(false);
  });
});

describe('PathGuard follows links', () => {
  it('refuses a Temp junction that points into System32', () => {
    const guard = fakeGuard({ 'C:\\Users\\emir\\AppData\\Local\\Temp\\evil': 'C:\\Windows\\System32' });
    const r = guard.check('C:\\Users\\emir\\AppData\\Local\\Temp\\evil\\kernel32.dll');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/junction/);
  });

  it('refuses a junction that leaves the whitelist', () => {
    const guard = fakeGuard({ 'C:\\Users\\emir\\AppData\\Local\\Temp\\out': 'D:\\Photos' });
    const r = guard.check('C:\\Users\\emir\\AppData\\Local\\Temp\\out\\img.jpg', {
      allowRoots: ['C:\\Users\\emir\\AppData\\Local\\Temp'],
    });
    expect(r.ok).toBe(false);
  });

  describe('with a real NTFS junction', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-guard-'));
    const allowed = path.join(base, 'allowed');
    const secret = path.join(base, 'secret');
    fs.mkdirSync(allowed);
    fs.mkdirSync(secret);
    fs.writeFileSync(path.join(secret, 'keep.txt'), 'x');
    fs.symlinkSync(secret, path.join(allowed, 'link'), 'junction');
    afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

    const cfg = defaultGuardConfig(env, [secret]);
    cfg.realpath = defaultRealpath;
    const guard = createPathGuard(cfg);

    it('detects the redirect and refuses', () => {
      const r = guard.check(path.join(allowed, 'link', 'keep.txt'), { allowRoots: [allowed] });
      expect(r.ok).toBe(false);
    });
  });
});
