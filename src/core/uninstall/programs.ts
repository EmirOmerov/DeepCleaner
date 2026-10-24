/** Installed-program model, parsed from the Uninstall registry keys. */

export type Scope = 'machine' | 'user';

/** One raw Uninstall registry entry, as produced by the PowerShell adapter. */
export interface RawUninstallEntry {
  KeyPath: string;
  KeyName: string;
  Scope: Scope;
  DisplayName?: string | null;
  DisplayVersion?: string | null;
  Publisher?: string | null;
  InstallLocation?: string | null;
  InstallDate?: string | null;
  EstimatedSize?: number | null;
  UninstallString?: string | null;
  QuietUninstallString?: string | null;
  DisplayIcon?: string | null;
  SystemComponent?: number | null;
  WindowsInstaller?: number | null;
  ParentKeyName?: string | null;
  ReleaseType?: string | null;
  NoRemove?: number | null;
}

export interface InstalledProgram {
  id: string;
  name: string;
  publisher: string;
  version: string;
  installLocation: string | null;
  sizeBytes: number;
  /** ISO date (yyyy-mm-dd) or null. */
  installDate: string | null;
  uninstallString: string;
  isMsi: boolean;
  productCode: string | null;
  /** Full registry key, e.g. HKEY_LOCAL_MACHINE\SOFTWARE\...\Uninstall\{GUID}. */
  registryKey: string;
  scope: Scope;
}

export interface UninstallCommand {
  file: string;
  /** Raw argument string, passed through verbatim. */
  args: string;
}

const GUID_RE = /\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}/;
const UPDATE_TYPES = /update|hotfix|security/i;

function clean(s: string | null | undefined): string {
  return (s ?? '').replace(/\0/g, '').trim();
}

/** Strip quotes, trailing separators and an icon index (",0"). */
export function cleanPath(p: string | null | undefined): string | null {
  let s = clean(p).replace(/^"+|"+$/g, '');
  s = s.replace(/,\s*-?\d+$/, '').replace(/^"+|"+$/g, '');
  if (s.length > 3) s = s.replace(/\\+$/, '');
  return /^[a-zA-Z]:\\/.test(s) ? s : null;
}

function parseInstallDate(s: string | null | undefined): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(clean(s));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Folder of the DisplayIcon executable, unless it points into Windows itself. */
function locationFromIcon(icon: string | null | undefined): string | null {
  const p = cleanPath(icon);
  if (!p || /\\windows\\|msiexec|\\installer\\/i.test(p)) return null;
  const idx = p.lastIndexOf('\\');
  if (idx <= 2) return null;
  // Icons often live in a "bin" subfolder; the program folder is its parent.
  return p.slice(0, idx).replace(/\\bin(64)?$/i, '');
}

/**
 * Turn raw Uninstall entries into the list a user would recognise from
 * "Apps & features": hidden system components, updates and child entries are
 * dropped, and the same product registered in several hives appears once.
 */
export function parsePrograms(raw: RawUninstallEntry[]): InstalledProgram[] {
  const out = new Map<string, InstalledProgram>();
  for (const e of raw) {
    const name = clean(e.DisplayName);
    const uninstall = clean(e.UninstallString);
    if (!name || !uninstall) continue;
    if (e.SystemComponent === 1 || e.NoRemove === 1) continue;
    if (clean(e.ParentKeyName) || UPDATE_TYPES.test(clean(e.ReleaseType))) continue;

    const isMsi = e.WindowsInstaller === 1 || /msiexec/i.test(uninstall);
    const productCode = GUID_RE.exec(e.KeyName)?.[0] ?? (isMsi ? GUID_RE.exec(uninstall)?.[0] ?? null : null);
    const program: InstalledProgram = {
      id: `${e.Scope}:${e.KeyPath}`.toLowerCase(),
      name,
      publisher: clean(e.Publisher),
      version: clean(e.DisplayVersion),
      installLocation: cleanPath(e.InstallLocation) ?? locationFromIcon(e.DisplayIcon),
      sizeBytes: Math.max(0, Number(e.EstimatedSize) || 0) * 1024,
      installDate: parseInstallDate(e.InstallDate),
      uninstallString: uninstall,
      isMsi,
      productCode,
      registryKey: e.KeyPath,
      scope: e.Scope,
    };
    const dedupe = `${name.toLowerCase()}|${program.version.toLowerCase()}`;
    if (!out.has(dedupe)) out.set(dedupe, program);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name, 'bs', { sensitivity: 'base' }));
}

/**
 * Split an UninstallString into an executable and a raw argument string.
 * MSI products always use `msiexec /x {ProductCode}` (interactive), which is
 * safer than replaying whatever arguments the vendor stored.
 */
export function parseUninstallCommand(p: Pick<InstalledProgram, 'uninstallString' | 'isMsi' | 'productCode'>): UninstallCommand | null {
  const s = clean(p.uninstallString);
  if (!s) return null;
  if (p.isMsi) {
    const code = p.productCode ?? GUID_RE.exec(s)?.[0];
    return code ? { file: 'msiexec.exe', args: `/x ${code}` } : null;
  }
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    if (end < 0) return null;
    return { file: s.slice(1, end), args: s.slice(end + 1).trim() };
  }
  const m = /^(.*?\.exe)(?=\s|$)/i.exec(s);
  if (m) return { file: m[1], args: s.slice(m[1].length).trim() };
  return { file: s, args: '' };
}
