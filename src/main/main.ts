import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { CacheCleaner } from '../core/cache/cacheCleaner';
import { defaultCacheTargets } from '../core/cache/cacheTargets';
import { pathSize } from '../core/fsutil';
import { ImageScanner } from '../core/images/imageScanner';
import { defaultScanRoots, LargeFileScanner } from '../core/largefiles/largeFiles';
import { HistoryLog } from '../core/quarantine/history';
import { Quarantine, type OpResult } from '../core/quarantine/quarantine';
import { createPathGuard, defaultGuardConfig } from '../core/safety/pathGuard';
import { defaultLeftoverLocations, findLeftovers, type LeftoverDeps, type Leftover } from '../core/uninstall/leftovers';
import { parsePrograms, parseUninstallCommand, type InstalledProgram } from '../core/uninstall/programs';
import { listInstalledPrograms, regKeyExists, regListSubkeys, runUninstaller, windowsRegistry } from '../platform/windows';
import { IPC, type SystemInfo, type UninstallOutcome } from '../shared/api';

// --- Services (composition root) -------------------------------------------

const dataDir = path.join(process.env.LOCALAPPDATA ?? app.getPath('userData'), 'DeepCleaner');
const vaultDir = path.join(dataDir, 'Quarantine');

// The app's own data folder is protected so no module can ever delete it.
const guard = createPathGuard(defaultGuardConfig(process.env, [dataDir]));
const history = new HistoryLog(path.join(dataDir, 'history.jsonl'));
const quarantine = new Quarantine({ vaultDir, guard, history, registry: windowsRegistry, retentionDays: 30 });
const cache = new CacheCleaner(defaultCacheTargets(process.env), guard, history);
const largeFiles = new LargeFileScanner();
let largeFilesScan: AbortController | null = null;

const MIN_LARGE_FILE = 10 * 1024 * 1024;

const images = new ImageScanner();
let imageScan: AbortController | null = null;

/** Pictures, Desktop and Downloads (plus OneDrive Pictures when present). */
function defaultImageRoots(): string[] {
  const profile = process.env.USERPROFILE ?? app.getPath('home');
  const candidates = [
    app.getPath('pictures'),
    app.getPath('desktop'),
    app.getPath('downloads'),
    path.join(profile, 'OneDrive', 'Pictures'),
  ];
  const seen = new Set<string>();
  return candidates.filter((p) => {
    const k = p.toLowerCase();
    if (seen.has(k) || !fs.existsSync(p)) return false;
    seen.add(k);
    return true;
  });
}

function similarityArg(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0.5, n)) : 0.9;
}

// Deep uninstall state: the last program list, and the last leftover scan per program.
let programs = new Map<string, InstalledProgram>();
const leftoverScans = new Map<string, Leftover[]>();

const leftoverDeps: LeftoverDeps = {
  listDir: async (dir) => {
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      return entries.filter((e) => !e.isSymbolicLink()).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    } catch {
      return [];
    }
  },
  exists: async (p) => fs.existsSync(p),
  size: (p) => pathSize(p).catch(() => 0),
  listRegSubkeys: regListSubkeys,
};

function programById(id: unknown): InstalledProgram {
  const p = typeof id === 'string' ? programs.get(id) : undefined;
  if (!p) throw new Error('Program nije pronađen. Osvježi listu.');
  return p;
}

async function uninstallProgram(id: unknown): Promise<UninstallOutcome> {
  const p = programById(id);
  const cmd = parseUninstallCommand(p);
  if (!cmd) throw new Error('Program nema ispravnu komandu za deinstalaciju.');
  const elevate = p.scope === 'machine' && !(await isAdmin());
  const res = await runUninstaller(cmd.file, cmd.args, elevate);
  const stillInstalled = await regKeyExists(p.registryKey);
  if (!stillInstalled) {
    history.append({ action: 'uninstall', module: 'uninstall', items: 1, bytes: p.sizeBytes, failed: 0, sample: [p.name] });
  }
  return { ...res, stillInstalled };
}

async function scanLeftovers(id: unknown): Promise<Leftover[]> {
  const p = programById(id);
  // Never look for leftovers of a program that is still installed (cancelled/failed uninstall).
  if (await regKeyExists(p.registryKey)) {
    throw new Error('Program je još instaliran. Ostaci se traže tek nakon uspješne deinstalacije.');
  }
  const others = [...programs.values()].filter((o) => o.id !== p.id);
  const list = await findLeftovers(p, others, defaultLeftoverLocations(process.env), leftoverDeps);
  leftoverScans.set(p.id, list);
  return list;
}

/** Only items from the last leftover scan of this program are accepted. */
async function removeLeftovers(id: unknown, value: unknown): Promise<OpResult> {
  const p = programById(id);
  const scanned = new Map((leftoverScans.get(p.id) ?? []).map((l) => [l.path.toLowerCase(), l]));
  const wanted = stringArray(value);
  const hits = wanted.map((w) => scanned.get(w.toLowerCase())).filter((l): l is Leftover => !!l);
  const rejected = wanted.filter((w) => !scanned.has(w.toLowerCase()));

  const files = await quarantine.quarantine(hits.filter((l) => l.kind !== 'registry').map((l) => l.path), 'uninstall');
  const keys = await quarantine.quarantineRegistry(hits.filter((l) => l.kind === 'registry').map((l) => l.path), 'uninstall');
  const merged: OpResult = {
    done: [...files.done, ...keys.done],
    failed: [...files.failed, ...keys.failed, ...rejected.map((r) => ({ path: r, reason: 'not from the last leftover scan' }))],
    bytes: files.bytes + keys.bytes,
  };
  const removed = new Set(merged.done.map((d) => d.path.toLowerCase()));
  leftoverScans.set(p.id, [...scanned.values()].filter((l) => !removed.has(l.path.toLowerCase())));
  return merged;
}

// --- Helpers -----------------------------------------------------------------

/** `net session` only succeeds in an elevated process. */
function isAdmin(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('net', ['session'], { windowsHide: true }, (err) => resolve(!err));
  });
}

async function diskUsage(drive = process.env.SystemDrive ?? 'C:') {
  const st = await fs.promises.statfs(drive + '\\');
  return { drive, total: st.blocks * st.bsize, free: st.bavail * st.bsize };
}

/** IPC payloads come from the renderer — validate before use. */
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new Error('expected an array of strings');
  }
  return value as string[];
}

function absolutePaths(value: unknown): string[] {
  const paths = stringArray(value);
  if (!paths.every((p) => path.win32.isAbsolute(p) && /^[a-zA-Z]:\\/.test(p))) {
    throw new Error('expected absolute local paths');
  }
  return paths;
}

/** Paths not from the last large-file scan (or locked) are refused before reaching the guard. */
async function largeFilesRemove(value: unknown, permanent: boolean) {
  const { known, rejected } = largeFiles.filterKnown(stringArray(value));
  const r = permanent
    ? await quarantine.deletePermanently(known, 'largefiles')
    : await quarantine.quarantine(known, 'largefiles');
  largeFiles.forget(r.done.map((d) => d.path));
  r.failed.push(...rejected.map((p) => ({ path: p, reason: 'not from the last scan, or locked' })));
  return r;
}

// --- IPC ---------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle(IPC.systemInfo, async (): Promise<SystemInfo> => ({
    isAdmin: await isAdmin(),
    disk: await diskUsage(),
    version: app.getVersion(),
  }));
  ipcMain.handle(IPC.cacheScan, () => cache.scan());
  ipcMain.handle(IPC.cacheClean, (_e, ids: unknown) => cache.clean(stringArray(ids)));
  ipcMain.handle(IPC.lfDefaultRoots, () => defaultScanRoots(process.env));
  ipcMain.handle(IPC.lfPickFolder, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], title: 'Odaberi folder za skeniranje' });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle(IPC.lfScan, async (e, roots: unknown, minBytes: unknown) => {
    largeFilesScan?.abort();
    const ac = (largeFilesScan = new AbortController());
    const min = Math.max(MIN_LARGE_FILE, Number(minBytes) || 0);
    try {
      return await largeFiles.scan({
        roots: absolutePaths(roots),
        minBytes: min,
        signal: ac.signal,
        onProgress: (p) => !e.sender.isDestroyed() && e.sender.send(IPC.lfProgress, p),
      });
    } finally {
      if (largeFilesScan === ac) largeFilesScan = null;
    }
  });
  ipcMain.handle(IPC.lfCancel, () => largeFilesScan?.abort());
  ipcMain.handle(IPC.lfQuarantine, (_e, paths: unknown) => largeFilesRemove(paths, false));
  ipcMain.handle(IPC.lfDelete, (_e, paths: unknown) => largeFilesRemove(paths, true));
  ipcMain.handle(IPC.lfReveal, (_e, p: unknown) => {
    const hit = typeof p === 'string' ? largeFiles.find(p) : undefined;
    if (hit) shell.showItemInFolder(hit.path);
  });
  ipcMain.handle(IPC.imgDefaultRoots, () => defaultImageRoots());
  ipcMain.handle(IPC.imgScan, async (e, roots: unknown, minSimilarity: unknown) => {
    imageScan?.abort();
    const ac = (imageScan = new AbortController());
    try {
      return await images.scan({
        roots: absolutePaths(roots),
        minSimilarity: similarityArg(minSimilarity),
        signal: ac.signal,
        onProgress: (p) => !e.sender.isDestroyed() && e.sender.send(IPC.imgProgress, p),
      });
    } finally {
      if (imageScan === ac) imageScan = null;
    }
  });
  ipcMain.handle(IPC.imgRegroup, (_e, minSimilarity: unknown) => images.regroup(similarityArg(minSimilarity)));
  ipcMain.handle(IPC.imgCancel, () => imageScan?.abort());
  ipcMain.handle(IPC.imgPreview, (_e, p: unknown, size: unknown) =>
    typeof p === 'string' ? images.preview(p, Number(size) || 256).catch(() => null) : null,
  );
  ipcMain.handle(IPC.imgQuarantine, async (_e, paths: unknown) => {
    const { known, rejected } = images.filterKnown(stringArray(paths));
    const r = await quarantine.quarantine(known, 'images');
    images.forget(r.done.map((d) => d.path));
    r.failed.push(...rejected.map((p) => ({ path: p, reason: 'not from the last image scan' })));
    return r;
  });
  ipcMain.handle(IPC.imgReveal, (_e, p: unknown) => {
    const { known } = images.filterKnown(stringArray([p]));
    if (known[0]) shell.showItemInFolder(known[0]);
  });
  ipcMain.handle(IPC.programsList, async () => {
    const list = parsePrograms(await listInstalledPrograms());
    programs = new Map(list.map((p) => [p.id, p]));
    return list;
  });
  ipcMain.handle(IPC.programsUninstall, (_e, id: unknown) => uninstallProgram(id));
  ipcMain.handle(IPC.programsIsInstalled, (_e, id: unknown) => regKeyExists(programById(id).registryKey));
  ipcMain.handle(IPC.programsLeftovers, (_e, id: unknown) => scanLeftovers(id));
  ipcMain.handle(IPC.programsRemoveLeftovers, (_e, id: unknown, paths: unknown) => removeLeftovers(id, paths));
  ipcMain.handle(IPC.quarantineList, () => quarantine.list());
  ipcMain.handle(IPC.quarantineRestore, (_e, ids: unknown) => quarantine.restore(stringArray(ids)));
  ipcMain.handle(IPC.quarantineRemove, (_e, ids: unknown) => quarantine.remove(stringArray(ids)));
  ipcMain.handle(IPC.historyList, () => history.read(500));
}

// --- Window ------------------------------------------------------------------

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#060a17',
    title: 'DeepCleaner',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Never navigate away or open new windows inside the app.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  registerIpc();
  // Expired quarantine items are purged once per launch.
  await quarantine.purgeExpired().catch(() => undefined);
  createWindow();
});

app.on('window-all-closed', () => app.quit());
