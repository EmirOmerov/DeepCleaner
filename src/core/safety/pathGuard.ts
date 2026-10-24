import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * PathGuard — the single gate every destructive operation must pass.
 *
 * Fails closed: anything that cannot be proven safe is refused. Both the
 * literal path and its resolved real path (junctions, symlinks, 8.3 names)
 * are checked, so a "Temp" junction pointing into System32 is rejected.
 */

export type GuardResult =
  | { ok: true; path: string }
  | { ok: false; path: string; reason: string };

export interface GuardConfig {
  /** Trees where nothing may be deleted: the root and every descendant. */
  protectedTrees: string[];
  /** Exceptions inside protected trees whose *contents* may be cleaned. */
  allowedInsideProtected: string[];
  /** Folders that must never be deleted themselves (contents are fine). */
  protectedExact: string[];
  /** File names never deletable anywhere (lowercase, exact or prefix match). */
  protectedFileNames: string[];
  /** Resolve a path to its final real path, or null if it does not exist. */
  realpath: (p: string) => string | null;
}

export interface CheckOptions {
  /** Whitelist mode: target must be strictly inside one of these roots. */
  allowRoots?: string[];
}

export interface PathGuard {
  check(target: string, opts?: CheckOptions): GuardResult;
}

const DRIVE_ABS = /^[a-zA-Z]:\\/;
const SHORT_NAME = /~\d/;

/** Canonical Windows form: backslashes, no \\?\ prefix, no `..`, no trailing separator. */
export function normalizePath(input: string): string {
  let s = input.trim().replace(/\//g, '\\');
  if (s.startsWith('\\\\?\\') || s.startsWith('\\\\.\\')) s = s.slice(4);
  s = path.win32.normalize(s);
  // Windows silently strips trailing dots and spaces from each segment.
  s = s
    .split('\\')
    .map((seg, i) => (i === 0 ? seg : seg.replace(/[. ]+$/, '')))
    .join('\\');
  if (s.length > 3 && s.endsWith('\\')) s = s.slice(0, -1);
  return s;
}

function key(p: string): string {
  return normalizePath(p).toLowerCase();
}

/** True when `child` equals `parent` or lies beneath it (both already keyed). */
function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith('\\') ? parent : parent + '\\';
  return child.startsWith(prefix);
}

function isStrictlyInside(child: string, parent: string): boolean {
  return child !== parent && isWithin(child, parent);
}

export function defaultRealpath(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/** Build the default protection rules from the Windows environment. */
export function defaultGuardConfig(
  env: NodeJS.ProcessEnv = process.env,
  extraProtectedTrees: string[] = [],
): GuardConfig {
  const drive = (env.SystemDrive || 'C:').replace(/\\$/, '');
  const winDir = env.SystemRoot || env.windir || `${drive}\\Windows`;
  const programData = env.ProgramData || `${drive}\\ProgramData`;
  const programFiles = env.ProgramFiles || `${drive}\\Program Files`;
  const programFilesX86 = env['ProgramFiles(x86)'] || `${drive}\\Program Files (x86)`;
  const userProfile = env.USERPROFILE || `${drive}\\Users\\Default`;
  const usersDir = path.win32.dirname(userProfile);

  return {
    protectedTrees: [
      winDir,
      `${drive}\\System Volume Information`,
      `${drive}\\$Recycle.Bin`,
      `${drive}\\Recovery`,
      `${drive}\\Boot`,
      `${drive}\\EFI`,
      `${programData}\\Microsoft`,
      `${programFiles}\\WindowsApps`,
      `${programFiles}\\Windows Defender`,
      `${programFiles}\\Common Files\\microsoft shared`,
      ...extraProtectedTrees,
    ],
    allowedInsideProtected: [
      `${winDir}\\Temp`,
      `${winDir}\\SoftwareDistribution\\Download`,
      `${winDir}\\Minidump`,
      `${winDir}\\LiveKernelReports`,
      `${programData}\\Microsoft\\Windows\\WER\\ReportArchive`,
      `${programData}\\Microsoft\\Windows\\WER\\ReportQueue`,
      // Shortcuts of uninstalled programs (the Programs folder itself stays protected).
      `${programData}\\Microsoft\\Windows\\Start Menu\\Programs`,
    ],
    protectedExact: [
      programFiles,
      programFilesX86,
      programData,
      usersDir,
      `${usersDir}\\Public`,
      `${usersDir}\\Default`,
      userProfile,
      env.APPDATA || `${userProfile}\\AppData\\Roaming`,
      env.LOCALAPPDATA || `${userProfile}\\AppData\\Local`,
      `${userProfile}\\AppData`,
      `${userProfile}\\AppData\\LocalLow`,
      env.TEMP || `${userProfile}\\AppData\\Local\\Temp`,
      ...['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos', 'OneDrive'].map(
        (d) => `${userProfile}\\${d}`,
      ),
    ],
    protectedFileNames: [
      'pagefile.sys',
      'hiberfil.sys',
      'swapfile.sys',
      'bootmgr',
      'bootnxt',
      'ntuser.dat',
      'ntuser.ini',
      'ntuser.pol',
      'usrclass.dat',
    ],
    realpath: defaultRealpath,
  };
}

export function createPathGuard(config: GuardConfig): PathGuard {
  const trees = config.protectedTrees.map(key);
  const allowed = config.allowedInsideProtected.map(key);
  const exact = new Set(config.protectedExact.map(key));
  const names = config.protectedFileNames.map((n) => n.toLowerCase());

  function ruleViolation(k: string): string | null {
    if (/^[a-z]:\\?$/.test(k)) return 'drive root';
    const base = path.win32.basename(k);
    if (names.some((n) => base === n || base.startsWith(n + '.') || base.startsWith(n + '{'))) {
      return `protected system file (${base})`;
    }
    if (exact.has(k)) return 'protected folder (contents may be cleaned, not the folder itself)';
    const tree = trees.find((t) => isWithin(k, t));
    if (tree && !allowed.some((a) => isStrictlyInside(k, a))) {
      return `inside protected system location (${tree})`;
    }
    return null;
  }

  return {
    check(target, opts = {}) {
      if (typeof target !== 'string' || target.trim() === '') {
        return { ok: false, path: String(target), reason: 'empty path' };
      }
      const literal = normalizePath(target);
      if (!DRIVE_ABS.test(literal)) {
        return { ok: false, path: literal, reason: 'only absolute local drive paths are allowed' };
      }
      if (literal.indexOf(':', 2) !== -1) {
        return { ok: false, path: literal, reason: 'alternate data streams are not allowed' };
      }
      const resolved = config.realpath(literal);
      const real = resolved ? normalizePath(resolved) : null;
      if (!real && literal.split('\\').some((seg) => SHORT_NAME.test(seg))) {
        return { ok: false, path: literal, reason: 'unresolvable 8.3 short name' };
      }

      // Roots are compared in both literal and resolved form (e.g. TEMP may use a short name).
      const roots = opts.allowRoots?.flatMap((r) => {
        const rr = config.realpath(normalizePath(r));
        return rr ? [key(r), key(rr)] : [key(r)];
      });

      const candidates = real && key(real) !== key(literal) ? [literal, real] : [literal];
      for (const c of candidates) {
        const k = key(c);
        const violation = ruleViolation(k);
        if (violation) {
          const via = c === literal ? '' : ' (via junction/symlink)';
          return { ok: false, path: literal, reason: violation + via };
        }
        if (roots) {
          if (!roots.some((r) => isStrictlyInside(k, r))) {
            return { ok: false, path: literal, reason: 'outside the allowed cleaning locations' };
          }
        }
      }
      return { ok: true, path: real ?? literal };
    },
  };
}
