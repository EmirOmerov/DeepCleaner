/**
 * The typed contract between the renderer and the main process.
 * The renderer never sees Node APIs — only this surface, via contextBridge.
 */
import type { CleanReport, TargetScan } from '../core/cache/cacheCleaner';
import type { HistoryEntry } from '../core/quarantine/history';
import type { OpResult, QuarantineItem } from '../core/quarantine/quarantine';

export type { CleanReport, HistoryEntry, OpResult, QuarantineItem, TargetScan };

export interface DiskUsage {
  drive: string;
  total: number;
  free: number;
}

export interface SystemInfo {
  isAdmin: boolean;
  disk: DiskUsage;
  version: string;
}

export interface DeepCleanerApi {
  system: {
    info(): Promise<SystemInfo>;
  };
  cache: {
    scan(): Promise<TargetScan[]>;
    clean(ids: string[]): Promise<CleanReport>;
  };
  quarantine: {
    list(): Promise<QuarantineItem[]>;
    restore(ids: string[]): Promise<OpResult>;
    remove(ids: string[]): Promise<OpResult>;
  };
  history: {
    list(): Promise<HistoryEntry[]>;
  };
}

/** IPC channel names, shared so main and preload can't drift apart. */
export const IPC = {
  systemInfo: 'system:info',
  cacheScan: 'cache:scan',
  cacheClean: 'cache:clean',
  quarantineList: 'quarantine:list',
  quarantineRestore: 'quarantine:restore',
  quarantineRemove: 'quarantine:remove',
  historyList: 'history:list',
} as const;
