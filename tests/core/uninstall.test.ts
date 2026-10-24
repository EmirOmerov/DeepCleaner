import { describe, expect, it } from 'vitest';
import { checkRegistryKey, normalizeRegistryKey } from '../../src/core/safety/registryGuard';
import { createPathGuard, defaultGuardConfig } from '../../src/core/safety/pathGuard';
import {
  findLeftovers,
  normalizeName,
  programNames,
  type DirEntry,
  type LeftoverDeps,
  type LeftoverLocations,
} from '../../src/core/uninstall/leftovers';
import { parsePrograms, parseUninstallCommand, type RawUninstallEntry } from '../../src/core/uninstall/programs';

// ---------------------------------------------------------------- registry guard

describe('RegistryGuard', () => {
  it.each([
    'HKCU\\Software\\Adobe\\Acrobat Reader',
    'HKEY_CURRENT_USER\\Software\\Spotify',
    'HKLM\\SOFTWARE\\VideoLAN\\VLC',
    'HKLM\\Software\\WOW6432Node\\Valve\\Steam',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{AC76BA86-7AD7-1033-7B44-AC0F074E4100}',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Steam',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Discord',
  ])('allows %s', (key) => expect(checkRegistryKey(key).ok).toBe(true));

  it.each([
    '',
    'HKLM',
    'HKCU\\Software',
    'HKLM\\SOFTWARE',
    'HKLM\\SOFTWARE\\WOW6432Node',
    'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Foo',
    'HKCR\\.txt',
    'HKU\\S-1-5-18\\Software\\X',
    'HKLM\\SOFTWARE\\Microsoft',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\X\\Sub',
    'HKCU\\Software\\Classes\\CLSID\\{x}',
    'HKLM\\SOFTWARE\\Policies\\Google',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Office',
    'HKCU\\Software\\..\\Microsoft',
    'HKLM\\SOFTWARE\\Intel\\Display',
  ])('refuses %j', (key) => expect(checkRegistryKey(key).ok).toBe(false));

  it('normalizes hive names and slashes', () => {
    expect(normalizeRegistryKey('HKEY_LOCAL_MACHINE\\\\SOFTWARE/Foo\\')).toBe('HKLM\\SOFTWARE\\Foo');
    expect(normalizeRegistryKey('HKCU:\\Software\\Foo')).toBe('HKCU\\Software\\Foo');
  });
});

// ---------------------------------------------------------------- programs

const raw = (over: Partial<RawUninstallEntry>): RawUninstallEntry => ({
  KeyPath: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\X',
  KeyName: 'X',
  Scope: 'machine',
  DisplayName: 'Thing',
  UninstallString: '"C:\\Program Files\\Thing\\uninst.exe"',
  ...over,
});

describe('parsePrograms', () => {
  it('drops hidden components, updates and child entries', () => {
    const list = parsePrograms([
      raw({ DisplayName: 'Visible' }),
      raw({ DisplayName: 'Hidden', SystemComponent: 1 }),
      raw({ DisplayName: 'KB123', ReleaseType: 'Security Update' }),
      raw({ DisplayName: 'Child', ParentKeyName: 'Office' }),
      raw({ DisplayName: 'No uninstall', UninstallString: '' }),
      raw({ DisplayName: '' }),
    ]);
    expect(list.map((p) => p.name)).toEqual(['Visible']);
  });

  it('dedupes the same product registered twice and keeps the first', () => {
    const list = parsePrograms([
      raw({ DisplayName: 'Zoom', DisplayVersion: '5.1', KeyPath: 'A' }),
      raw({ DisplayName: 'zoom', DisplayVersion: '5.1', KeyPath: 'B', Scope: 'user' }),
    ]);
    expect(list).toHaveLength(1);
    expect(list[0].registryKey).toBe('A');
  });

  it('parses size, date, MSI product code and install location', () => {
    const [p] = parsePrograms([
      raw({
        KeyName: '{AC76BA86-7AD7-1033-7B44-AC0F074E4100}',
        WindowsInstaller: 1,
        EstimatedSize: 1024,
        InstallDate: '20240611',
        InstallLocation: '"C:\\Program Files\\Adobe\\Acrobat DC\\"',
        UninstallString: 'MsiExec.exe /I{AC76BA86-7AD7-1033-7B44-AC0F074E4100}',
      }),
    ]);
    expect(p.sizeBytes).toBe(1024 * 1024);
    expect(p.installDate).toBe('2024-06-11');
    expect(p.isMsi).toBe(true);
    expect(p.productCode).toBe('{AC76BA86-7AD7-1033-7B44-AC0F074E4100}');
    expect(p.installLocation).toBe('C:\\Program Files\\Adobe\\Acrobat DC');
  });

  it('falls back to the DisplayIcon folder but never to Windows paths', () => {
    const [a] = parsePrograms([raw({ DisplayIcon: 'C:\\Program Files\\VLC\\vlc.exe,0' })]);
    expect(a.installLocation).toBe('C:\\Program Files\\VLC');
    const [b] = parsePrograms([raw({ DisplayIcon: 'C:\\Windows\\System32\\msiexec.exe,0' })]);
    expect(b.installLocation).toBeNull();
    const [c] = parsePrograms([raw({ DisplayIcon: 'C:\\Program Files\\Android\\Android Studio\\bin\\studio64.exe' })]);
    expect(c.installLocation).toBe('C:\\Program Files\\Android\\Android Studio');
  });
});

describe('parseUninstallCommand', () => {
  const cmd = (uninstallString: string, isMsi = false, productCode: string | null = null) =>
    parseUninstallCommand({ uninstallString, isMsi, productCode });

  it.each([
    ['"C:\\Program Files\\VLC\\uninstall.exe"', 'C:\\Program Files\\VLC\\uninstall.exe', ''],
    ['"C:\\Program Files\\App\\unins000.exe" /SILENT', 'C:\\Program Files\\App\\unins000.exe', '/SILENT'],
    ['C:\\Program Files\\7-Zip\\Uninstall.exe', 'C:\\Program Files\\7-Zip\\Uninstall.exe', ''],
    ['C:\\Users\\e\\AppData\\Local\\Discord\\Update.exe --uninstall', 'C:\\Users\\e\\AppData\\Local\\Discord\\Update.exe', '--uninstall'],
  ])('%s', (s, file, args) => expect(cmd(s)).toEqual({ file, args }));

  it('always uses msiexec /x {ProductCode} for MSI', () => {
    expect(cmd('MsiExec.exe /I{AC76BA86-7AD7-1033-7B44-AC0F074E4100} /quiet', true)).toEqual({
      file: 'msiexec.exe',
      args: '/x {AC76BA86-7AD7-1033-7B44-AC0F074E4100}',
    });
  });

  it('returns null for an unterminated quote', () => {
    expect(cmd('"C:\\broken')).toBeNull();
  });
});

// ---------------------------------------------------------------- leftovers

describe('normalizeName / programNames', () => {
  it.each([
    ['Mozilla Firefox (x64 en-US)', 'mozilla firefox'],
    ['7-Zip 23.01 (x64)', '7 zip'],
    ['Notepad++ (64-bit x64)', 'notepad++'],
    ['VLC media player', 'vlc media player'],
  ])('%s -> %s', (a, b) => expect(normalizeName(a)).toBe(b));

  it('adds the product name without the publisher prefix', () => {
    expect([...programNames({ name: 'Mozilla Firefox', publisher: 'Mozilla' })]).toContain('firefox');
  });

  it('never yields generic or tiny names', () => {
    expect(programNames({ name: 'Tools', publisher: 'X' }).size).toBe(0);
    expect(programNames({ name: 'R', publisher: 'R Foundation' }).size).toBe(0);
  });
});

/** In-memory fake filesystem + registry. */
function fakeDeps(tree: Record<string, string[]>, reg: Record<string, string[]>): LeftoverDeps {
  const dirs = new Map(Object.entries(tree).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    listDir: async (d) =>
      (dirs.get(d.toLowerCase()) ?? []).map((n): DirEntry => ({ name: n.replace(/\/$/, ''), isDir: n.endsWith('/') })),
    exists: async (p) => dirs.has(p.toLowerCase()),
    size: async () => 100,
    listRegSubkeys: async (k) => reg[k] ?? [],
  };
}

const LOC: LeftoverLocations = {
  folders: ['C:\\Program Files', 'C:\\ProgramData', 'C:\\Users\\e\\AppData\\Roaming'],
  startMenus: ['C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs'],
  registryRoots: ['HKCU\\Software', 'HKLM\\Software'],
};

describe('findLeftovers', () => {
  const vlc = { name: 'VLC media player', publisher: 'VideoLAN', installLocation: 'C:\\Program Files\\VideoLAN\\VLC' };

  it('finds install location, publisher subfolders, shortcuts and registry keys', async () => {
    const deps = fakeDeps(
      {
        'C:\\Program Files': ['VideoLAN/', 'Other App/'],
        'C:\\Program Files\\VideoLAN': ['VLC/', 'Shared/'],
        'C:\\Program Files\\VideoLAN\\VLC': [],
        'C:\\Users\\e\\AppData\\Roaming': ['vlc/', 'VLC media player/'],
        'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs': ['VideoLAN/', 'VLC media player.lnk', 'Excel.lnk'],
      },
      { 'HKCU\\Software': ['VideoLAN', 'Valve'], 'HKCU\\Software\\VideoLAN': ['VLC'], 'HKLM\\Software': ['VLC media player'] },
    );
    const r = await findLeftovers(vlc, [], LOC, deps);
    const paths = r.map((l) => l.path);
    expect(paths).toContain('C:\\Program Files\\VideoLAN\\VLC');
    expect(paths).toContain('C:\\Users\\e\\AppData\\Roaming\\VLC media player');
    expect(paths).toContain('C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\VLC media player.lnk');
    expect(paths).toContain('HKCU\\Software\\VideoLAN\\VLC');
    expect(paths).toContain('HKLM\\Software\\VLC media player');
    // never the publisher folder/key itself, never unrelated entries
    expect(paths).not.toContain('C:\\Program Files\\VideoLAN');
    expect(paths).not.toContain('HKCU\\Software\\VideoLAN');
    expect(paths.some((p) => /Shared|Other App|Excel|Valve/.test(p))).toBe(false);
    // first-word match inside a publisher key is never pre-selected
    expect(r.find((l) => l.path === 'HKCU\\Software\\VideoLAN\\VLC')?.risk).toBe('review');
    expect(r.find((l) => l.path === 'HKLM\\Software\\VLC media player')?.risk).toBe('safe');
    // a bare top-level "vlc" folder is NOT matched (too loose outside a publisher folder)
    expect(paths).not.toContain('C:\\Users\\e\\AppData\\Roaming\\vlc');
  });

  it('skips names that also belong to a still-installed program', async () => {
    const deps = fakeDeps({ 'C:\\Program Files': ['Python/'] }, {});
    const py311 = { name: 'Python 3.11.4 (64-bit)', publisher: 'Python Software Foundation', installLocation: null };
    const py312 = { name: 'Python 3.12.0 (64-bit)', publisher: 'Python Software Foundation', installLocation: null };
    expect(await findLeftovers(py311, [py312], LOC, deps)).toEqual([]);
  });

  it('marks an install location shared with another program as review', async () => {
    const deps = fakeDeps({ 'C:\\Games\\Suite': [] }, {});
    const a = { name: 'Suite Game A', publisher: 'X', installLocation: 'C:\\Games\\Suite' };
    const b = { name: 'Suite Game B', publisher: 'X', installLocation: 'C:\\Games\\Suite\\B' };
    const [l] = await findLeftovers(a, [b], LOC, deps);
    expect(l.risk).toBe('review');
  });

  it('ignores an install location that is a top-level folder like Program Files', async () => {
    const deps = fakeDeps({ 'C:\\Program Files': [] }, {});
    const bad = { name: 'Weird', publisher: 'X', installLocation: 'C:\\Program Files' };
    expect(await findLeftovers(bad, [], LOC, deps)).toEqual([]);
  });

  it('never matches Microsoft or generic folders', async () => {
    const deps = fakeDeps(
      { 'C:\\ProgramData': ['Microsoft/', 'Package Cache/'], 'C:\\ProgramData\\Microsoft': ['Teams/'] },
      { 'HKLM\\Software': ['Microsoft'] },
    );
    const teams = { name: 'Microsoft Teams', publisher: 'Microsoft Corporation', installLocation: null };
    expect(await findLeftovers(teams, [], LOC, deps)).toEqual([]);
  });
});

describe('PathGuard and Start Menu shortcuts', () => {
  const guard = createPathGuard({
    ...defaultGuardConfig({ SystemDrive: 'C:', ProgramData: 'C:\\ProgramData', USERPROFILE: 'C:\\Users\\e' }),
    realpath: (p) => p,
  });
  it('allows a program shortcut folder but not the Programs folder itself', () => {
    expect(guard.check('C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\VideoLAN').ok).toBe(true);
    expect(guard.check('C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs').ok).toBe(false);
    expect(guard.check('C:\\ProgramData\\Microsoft\\Windows\\Start Menu').ok).toBe(false);
  });
});
