/**
 * RegistryGuard — the registry counterpart of PathGuard.
 *
 * Only application keys may be removed: HKCU\Software\<Vendor>[\...] and
 * HKLM\Software[\WOW6432Node]\<Vendor>[\...], plus a program's own entry
 * directly under ...\CurrentVersion\Uninstall. Everything else — Microsoft,
 * Classes, Policies, hive roots, other hives — is refused.
 */

export type RegistryGuardResult = { ok: true; key: string } | { ok: false; key: string; reason: string };

const HIVE_ALIASES: Record<string, string> = {
  HKEY_CURRENT_USER: 'HKCU',
  HKEY_LOCAL_MACHINE: 'HKLM',
  HKCU: 'HKCU',
  HKLM: 'HKLM',
};

/** Second-level names under Software that are never deletable (lowercase). */
const DENY_VENDOR = new Set([
  'microsoft',
  'classes',
  'policies',
  'wow6432node',
  'clients',
  'registeredapplications',
  'odbc',
  'windows',
  'intel',
  'nvidia corporation',
  'amd',
  'realtek',
]);

const UNINSTALL_RE = /^software\\(wow6432node\\)?microsoft\\windows\\currentversion\\uninstall\\[^\\]+$/;

/** Canonical form: short hive name, single backslashes, no trailing separator, no `HKLM:` drive syntax. */
export function normalizeRegistryKey(input: string): string {
  const s = input.trim().replace(/\//g, '\\').replace(/\\+/g, '\\').replace(/\\$/, '');
  const [hive, ...rest] = s.split('\\');
  const short = HIVE_ALIASES[hive.replace(/:$/, '').toUpperCase()] ?? hive.toUpperCase();
  return [short, ...rest].join('\\');
}

export function checkRegistryKey(input: string): RegistryGuardResult {
  if (typeof input !== 'string' || !input.trim()) return { ok: false, key: String(input), reason: 'empty key' };
  const key = normalizeRegistryKey(input);
  const [hive, ...parts] = key.split('\\');
  if (hive !== 'HKCU' && hive !== 'HKLM') return { ok: false, key, reason: 'only HKCU and HKLM application keys' };
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return { ok: false, key, reason: 'invalid key path' };

  const lower = parts.map((p) => p.toLowerCase());
  const tail = lower.join('\\');

  // A program's own Add/Remove Programs entry (exactly one level below Uninstall).
  if (UNINSTALL_RE.test(tail)) return { ok: true, key };

  if (lower[0] !== 'software') return { ok: false, key, reason: 'outside HKxx\\Software' };
  const vendorIdx = lower[1] === 'wow6432node' ? 2 : 1;
  const vendor = lower[vendorIdx];
  if (!vendor) return { ok: false, key, reason: 'cannot delete the Software root' };
  if (DENY_VENDOR.has(vendor)) return { ok: false, key, reason: `protected registry area (${parts[vendorIdx]})` };
  return { ok: true, key };
}
