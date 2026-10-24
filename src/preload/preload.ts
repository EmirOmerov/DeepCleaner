import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type DeepCleanerApi } from '../shared/api';

// Bundled by esbuild (sandboxed preloads cannot require local files).
const api: DeepCleanerApi = {
  system: {
    info: () => ipcRenderer.invoke(IPC.systemInfo),
  },
  cache: {
    scan: () => ipcRenderer.invoke(IPC.cacheScan),
    clean: (ids) => ipcRenderer.invoke(IPC.cacheClean, ids),
  },
  largeFiles: {
    defaultRoots: () => ipcRenderer.invoke(IPC.lfDefaultRoots),
    pickFolder: () => ipcRenderer.invoke(IPC.lfPickFolder),
    scan: (roots, minBytes) => ipcRenderer.invoke(IPC.lfScan, roots, minBytes),
    cancel: () => ipcRenderer.invoke(IPC.lfCancel),
    onProgress: (cb) => {
      const listener = (_e: unknown, p: Parameters<typeof cb>[0]) => cb(p);
      ipcRenderer.on(IPC.lfProgress, listener);
      return () => ipcRenderer.removeListener(IPC.lfProgress, listener);
    },
    quarantine: (paths) => ipcRenderer.invoke(IPC.lfQuarantine, paths),
    deletePermanently: (paths) => ipcRenderer.invoke(IPC.lfDelete, paths),
    reveal: (p) => ipcRenderer.invoke(IPC.lfReveal, p),
  },
  quarantine: {
    list: () => ipcRenderer.invoke(IPC.quarantineList),
    restore: (ids) => ipcRenderer.invoke(IPC.quarantineRestore, ids),
    remove: (ids) => ipcRenderer.invoke(IPC.quarantineRemove, ids),
  },
  history: {
    list: () => ipcRenderer.invoke(IPC.historyList),
  },
};

contextBridge.exposeInMainWorld('deepCleaner', api);
