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
