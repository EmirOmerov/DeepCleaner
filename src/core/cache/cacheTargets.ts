/**
 * The complete whitelist of locations the cache cleaner may touch.
 * Nothing outside these roots is ever deleted by the cache module — the
 * cleaner passes these roots to PathGuard as `allowRoots` for every file.
 *
 * A `*` segment matches any single child folder (e.g. browser profiles).
 */
export interface CacheTarget {
  id: string;
  label: string;
  description: string;
  roots: string[];
  /** Only files whose name matches are deleted. */
  filePattern?: RegExp;
  /** Files modified more recently than this are left alone (installers in progress, open docs). */
  minAgeHours: number;
  requiresAdmin: boolean;
  /** Processes that lock this cache while running — used to warn the user. */
  lockedBy?: string[];
}

const BROWSER_CACHE_DIRS = ['Cache', 'Code Cache', 'GPUCache'];

export function defaultCacheTargets(env: NodeJS.ProcessEnv = process.env): CacheTarget[] {
  const drive = (env.SystemDrive || 'C:').replace(/\\$/, '');
  const win = env.SystemRoot || `${drive}\\Windows`;
  const local = env.LOCALAPPDATA || `${env.USERPROFILE}\\AppData\\Local`;
  const programData = env.ProgramData || `${drive}\\ProgramData`;
  const temp = env.TEMP || `${local}\\Temp`;

  const chromium = (base: string) => BROWSER_CACHE_DIRS.map((d) => `${base}\\User Data\\*\\${d}`);

  return [
    {
      id: 'user-temp',
      label: 'Korisnički Temp',
      description: 'Privremeni fajlovi programa (%TEMP%). Fajlovi mlađi od 24h se preskaču.',
      roots: [temp],
      minAgeHours: 24,
      requiresAdmin: false,
    },
    {
      id: 'windows-temp',
      label: 'Windows Temp',
      description: 'Sistemski privremeni fajlovi (C:\\Windows\\Temp).',
      roots: [`${win}\\Temp`],
      minAgeHours: 24,
      requiresAdmin: true,
    },
    {
      id: 'wu-download',
      label: 'Windows Update preuzimanja',
      description: 'Već instalirani paketi ažuriranja (SoftwareDistribution\\Download).',
      roots: [`${win}\\SoftwareDistribution\\Download`],
      minAgeHours: 72,
      requiresAdmin: true,
    },
    {
      id: 'thumbnails',
      label: 'Thumbnail cache',
      description: 'Sličice u Exploreru. Windows ih ponovo generiše po potrebi.',
      roots: [`${local}\\Microsoft\\Windows\\Explorer`],
      filePattern: /^(thumbcache|iconcache)_.*\.db$/i,
      minAgeHours: 0,
      requiresAdmin: false,
      lockedBy: ['explorer.exe'],
    },
    {
      id: 'browser-edge',
      label: 'Microsoft Edge cache',
      description: 'Keš stranica i slika. Lozinke, historija i kolačići se NE diraju.',
      roots: chromium(`${local}\\Microsoft\\Edge`),
      minAgeHours: 0,
      requiresAdmin: false,
      lockedBy: ['msedge.exe'],
    },
    {
      id: 'browser-chrome',
      label: 'Google Chrome cache',
      description: 'Keš stranica i slika. Lozinke, historija i kolačići se NE diraju.',
      roots: chromium(`${local}\\Google\\Chrome`),
      minAgeHours: 0,
      requiresAdmin: false,
      lockedBy: ['chrome.exe'],
    },
    {
      id: 'browser-firefox',
      label: 'Firefox cache',
      description: 'Keš stranica (cache2). Profil i podaci ostaju netaknuti.',
      roots: [`${local}\\Mozilla\\Firefox\\Profiles\\*\\cache2`],
      minAgeHours: 0,
      requiresAdmin: false,
      lockedBy: ['firefox.exe'],
    },
    {
      id: 'crash-reports',
      label: 'Izvještaji o padovima',
      description: 'Crash dumpovi i Windows Error Reporting arhive.',
      roots: [
        `${local}\\CrashDumps`,
        `${local}\\Microsoft\\Windows\\WER\\ReportArchive`,
        `${local}\\Microsoft\\Windows\\WER\\ReportQueue`,
        `${programData}\\Microsoft\\Windows\\WER\\ReportArchive`,
        `${programData}\\Microsoft\\Windows\\WER\\ReportQueue`,
      ],
      minAgeHours: 0,
      requiresAdmin: false,
    },
    {
      id: 'system-dumps',
      label: 'Sistemski memory dumpovi',
      description: 'Minidump i LiveKernelReports nakon plavog ekrana.',
      roots: [`${win}\\Minidump`, `${win}\\LiveKernelReports`],
      minAgeHours: 0,
      requiresAdmin: true,
    },
  ];
}
