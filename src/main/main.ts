import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';
import { CacheCleaner } from '../core/cache/cacheCleaner';
import { defaultCacheTargets } from '../core/cache/cacheTargets';
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

// --- IPC ---------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle(IPC.systemInfo, async (): Promise<SystemInfo> => ({
    isAdmin: await isAdmin(),
    disk: await diskUsage(),
    version: app.getVersion(),
  }));
  ipcMain.handle(IPC.cacheScan, () => cache.scan());
  ipcMain.handle(IPC.cacheClean, (_e, ids: unknown) => cache.clean(stringArray(ids)));
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
