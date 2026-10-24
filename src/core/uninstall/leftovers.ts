import * as path from 'node:path';
import type { InstalledProgram } from './programs';

/**
 * Leftover detection after an uninstall.
 *
 * Matching is deliberately conservative — a false negative leaves a few MB
 * behind, a false positive deletes someone else's data. Rules:
 *  - a folder/key matches only if its normalised name EQUALS the program's
 *    normalised name (or the name minus the publisher prefix);
 *  - publisher folders are only descended into, never removed themselves;
 *  - generic names (Common Files, Microsoft, Cache, …) never match;
 *  - anything that also matches a still-installed program is skipped.
 */

export type LeftoverKind = 'folder' | 'file' | 'shortcut' | 'registry';
export type Risk = 'safe' | 'review';

export interface Leftover {
  kind: LeftoverKind;
  path: string;
  risk: Risk;
  reason: string;
  bytes: number;
}

export interface DirEntry {
  name: string;
  isDir: boolean;
}

export interface LeftoverDeps {
  /** Children of a folder (links excluded). Missing folder → []. */
  listDir(dir: string): Promise<DirEntry[]>;
  exists(p: string): Promise<boolean>;
  size(p: string): Promise<number>;
  /** Child key names of a registry key. Missing key → []. */
  listRegSubkeys(key: string): Promise<string[]>;
}

export interface LeftoverLocations {
  /** Folders whose direct children are compared with the program name. */
  folders: string[];
  /** Start Menu "Programs" folders (shortcut folders and .lnk files). */
  startMenus: string[];
  /** Registry roots whose subkeys are compared (e.g. HKCU\Software). */
  registryRoots: string[];
}

export function defaultLeftoverLocations(env: NodeJS.ProcessEnv = process.env): LeftoverLocations {
  const drive = env.SystemDrive || 'C:';
  const profile = env.USERPROFILE || `${drive}\\Users\\Default`;
  const programData = env.ProgramData || `${drive}\\ProgramData`;
  const appData = env.APPDATA || `${profile}\\AppData\\Roaming`;
  return {
    folders: [
      env.ProgramFiles || `${drive}\\Program Files`,
      env['ProgramFiles(x86)'] || `${drive}\\Program Files (x86)`,
      programData,
      appData,
      env.LOCALAPPDATA || `${profile}\\AppData\\Local`,
      `${profile}\\AppData\\LocalLow`,
      `${env.LOCALAPPDATA || `${profile}\\AppData\\Local`}\\Programs`,
    ],
    startMenus: [
      `${appData}\\Microsoft\\Windows\\Start Menu\\Programs`,
      `${programData}\\Microsoft\\Windows\\Start Menu\\Programs`,
    ],
    registryRoots: ['HKCU\\Software', 'HKLM\\Software', 'HKLM\\Software\\WOW6432Node'],
  };
}

/** Names that are never treated as belonging to a single program. */
const GENERIC = new Set([
  'common files', 'microsoft', 'microsoft shared', 'windows', 'windows nt', 'windowsapps', 'temp', 'tmp',
  'cache', 'caches', 'data', 'packages', 'programs', 'program', 'installer', 'installers', 'update', 'updates',
  'logs', 'log', 'config', 'settings', 'users', 'public', 'default', 'system', 'shared', 'tools', 'bin',
  'app', 'apps', 'application', 'applications', 'software', 'games', 'downloads', 'documents', 'crashdumps',
  'package cache', 'start menu', 'desktop', 'local', 'roaming', 'locallow', 'google', 'mozilla', 'adobe',
  'intel', 'nvidia', 'nvidia corporation', 'amd', 'realtek', 'oracle', 'apple', 'classes', 'policies',
  'wow6432node', 'clients', 'odbc', 'drivers', 'driver', 'support', 'helper', 'service', 'services',
]);

const SUFFIXES = /\b(inc|llc|ltd|limited|corp|corporation|co|gmbh|ag|sa|srl|bv|software|technologies|technology|team|foundation|project)\b/g;

/** Lowercase, drop parentheses, versions, architecture tags and punctuation. */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\bv?\d+(\.\d+)+\b/g, ' ')
    .replace(/\b(x64|x86|64-bit|32-bit|amd64|arm64|win64|win32)\b/g, ' ')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePublisher(s: string): string {
  return normalizeName(s).replace(SUFFIXES, ' ').replace(/\s+/g, ' ').trim();
}

type ProgramLike = Pick<InstalledProgram, 'name' | 'publisher' | 'installLocation'>;

/** The set of normalised names a program's folders/keys may carry. */
export function programNames(p: Pick<ProgramLike, 'name' | 'publisher'>): Set<string> {
  const names = new Set<string>();
  const n = normalizeName(p.name);
  const pub = normalizePublisher(p.publisher);
  names.add(n);
  names.add(n.replace(/\s+/g, ''));
  if (pub && n.startsWith(pub + ' ')) {
    const product = n.slice(pub.length + 1);
    names.add(product);
    names.add(product.replace(/\s+/g, ''));
  }
  for (const x of [...names]) if (x.length < 3 || GENERIC.has(x)) names.delete(x);
  return names;
}

function isWithin(child: string, parent: string): boolean {
  const c = child.toLowerCase();
  const p = parent.toLowerCase().replace(/\\$/, '');
  return c === p || c.startsWith(p + '\\');
}

export async function findLeftovers(
  program: ProgramLike,
  others: ProgramLike[],
  locations: LeftoverLocations,
  deps: LeftoverDeps,
): Promise<Leftover[]> {
  const names = programNames(program);
  if (!names.size) return [];
  const pub = normalizePublisher(program.publisher);
  const otherNames = new Set(others.flatMap((o) => [...programNames(o)]));
  const otherLocations = others.map((o) => o.installLocation).filter((l): l is string => !!l);

  const matches = (raw: string) => {
    const n = normalizeName(raw.replace(/\.lnk$/i, ''));
    return (names.has(n) || names.has(n.replace(/\s+/g, ''))) && !otherNames.has(n);
  };
  // Inside a publisher folder/key only: the first word of the name ("VideoLAN\VLC" for
  // "VLC media player") is accepted too, but flagged for review instead of pre-selected.
  const firstWord = normalizeName(program.name).split(' ')[0];
  const looseInPublisher = (raw: string) => {
    const n = normalizeName(raw);
    return firstWord.length >= 3 && !GENERIC.has(firstWord) && n === firstWord && !otherNames.has(n);
  };
  const isPublisher = (raw: string) => {
    const n = normalizePublisher(raw);
    return pub.length >= 3 && n === pub && !GENERIC.has(normalizeName(raw));
  };
  const usedByOther = (p: string) =>
    otherLocations.some((loc) => isWithin(loc, p) || isWithin(p, loc));

  const found = new Map<string, Leftover>();
  const add = (l: Omit<Leftover, 'bytes'>) => {
    const k = l.path.toLowerCase();
    if (found.has(k)) return;
    found.set(k, { ...l, bytes: 0 });
  };

  // 1. The install location recorded by the program itself.
  const loc = program.installLocation;
  const locationIsRoot = loc && locations.folders.some((f) => f.toLowerCase() === loc.toLowerCase());
  if (loc && !locationIsRoot && (await deps.exists(loc))) {
    add({
      kind: 'folder',
      path: loc,
      risk: usedByOther(loc) ? 'review' : 'safe',
      reason: usedByOther(loc) ? 'Lokacija instalacije, dijeli je drugi program' : 'Lokacija instalacije iz registra',
    });
  }

  // 2. Folders named after the program (directly, or inside a publisher folder).
  for (const base of locations.folders) {
    for (const e of await deps.listDir(base)) {
      if (!e.isDir) continue;
      const full = path.win32.join(base, e.name);
      if (matches(e.name)) {
        if (!usedByOther(full)) add({ kind: 'folder', path: full, risk: 'safe', reason: 'Ime foldera odgovara programu' });
      } else if (isPublisher(e.name)) {
        for (const c of await deps.listDir(full)) {
          const sub = path.win32.join(full, c.name);
          if (!c.isDir || usedByOther(sub)) continue;
          if (matches(c.name)) add({ kind: 'folder', path: sub, risk: 'safe', reason: `Folder proizvođača (${e.name})` });
          else if (looseInPublisher(c.name)) add({ kind: 'folder', path: sub, risk: 'review', reason: `Vjerovatno ovaj program (${e.name})` });
        }
      }
    }
  }

  // 3. Start Menu shortcuts.
  for (const menu of locations.startMenus) {
    for (const e of await deps.listDir(menu)) {
      const full = path.win32.join(menu, e.name);
      if (e.isDir ? matches(e.name) : /\.lnk$/i.test(e.name) && matches(e.name)) {
        add({ kind: 'shortcut', path: full, risk: 'safe', reason: 'Prečica u Start meniju' });
      }
    }
  }

  // 4. Registry keys named after the program (directly, or under a publisher key).
  for (const root of locations.registryRoots) {
    for (const sub of await deps.listRegSubkeys(root)) {
      const key = `${root}\\${sub}`;
      if (matches(sub)) {
        add({ kind: 'registry', path: key, risk: 'safe', reason: 'Postavke programa u registru' });
      } else if (isPublisher(sub)) {
        for (const child of await deps.listRegSubkeys(key)) {
          if (matches(child)) {
            add({ kind: 'registry', path: `${key}\\${child}`, risk: 'safe', reason: `Ključ proizvođača (${sub})` });
          } else if (looseInPublisher(child)) {
            add({ kind: 'registry', path: `${key}\\${child}`, risk: 'review', reason: `Vjerovatno ovaj program (${sub})` });
          }
        }
      }
    }
  }

  // Drop entries nested inside another found folder, then measure.
  const all = [...found.values()];
  const folders = all.filter((l) => l.kind !== 'registry');
  const result = all.filter(
    (l) => l.kind === 'registry' || !folders.some((f) => f !== l && isWithin(l.path, f.path)),
  );
  for (const l of result) if (l.kind !== 'registry') l.bytes = await deps.size(l.path);
  return result.sort((a, b) => a.kind.localeCompare(b.kind) || b.bytes - a.bytes);
}
