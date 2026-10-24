import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { CacheCleaner } from '../core/cache/cacheCleaner';
import { defaultCacheTargets } from '../core/cache/cacheTargets';
import { defaultScanRoots, LargeFileScanner } from '../core/largefiles/largeFiles';
import { HistoryLog } from '../core/quarantine/history';
import { Quarantine } from '../core/quarantine/quarantine';
import { createPathGuard, defaultGuardConfig } from '../core/safety/pathGuard';
import { IPC, type SystemInfo } from '../shared/api';

// --- Services (composition root) -------------------------------------------

const dataDir = path.join(process.env.LOCALAPPDATA ?? app.getPath('userData'), 'DeepCleaner');
const vaultDir = path.join(dataDir, 'Quarantine');

// The app's own data folder is protected so no module can ever delete it.
const guard = createPathGuard(defaultGuardConfig(process.env, [dataDir]));
const history = new HistoryLog(path.join(dataDir, 'history.jsonl'));
const quarantine = new Quarantine({ vaultDir, guard, history, retentionDays: 30 });
const cache = new CacheCleaner(defaultCacheTargets(process.env), guard, history);
const largeFiles = new LargeFileScanner();
let largeFilesScan: AbortController | null = null;

const MIN_LARGE_FILE = 10 * 1024 * 1024;

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
