/**
 * The typed contract between the renderer and the main process.
 * The renderer never sees Node APIs — only this surface, via contextBridge.
 */
import type { CleanReport, TargetScan } from '../core/cache/cacheCleaner';
import type { FileCategory, LargeFile, ScanProgress } from '../core/largefiles/largeFiles';
import type { HistoryEntry } from '../core/quarantine/history';
import type { OpResult, QuarantineItem } from '../core/quarantine/quarantine';

export type { CleanReport, FileCategory, HistoryEntry, LargeFile, OpResult, QuarantineItem, ScanProgress, TargetScan };

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
  largeFiles: {
    defaultRoots(): Promise<string[]>;
    pickFolder(): Promise<string | null>;
    scan(roots: string[], minBytes: number): Promise<LargeFile[]>;
    cancel(): Promise<void>;
    /** Subscribe to scan progress; returns an unsubscribe function. */
    onProgress(cb: (p: ScanProgress) => void): () => void;
    /** Only paths from the last scan are accepted; others are reported as failed. */
    quarantine(paths: string[]): Promise<OpResult>;
    deletePermanently(paths: string[]): Promise<OpResult>;
    reveal(path: string): Promise<void>;
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
  lfDefaultRoots: 'largefiles:default-roots',
  lfPickFolder: 'largefiles:pick-folder',
  lfScan: 'largefiles:scan',
  lfCancel: 'largefiles:cancel',
  lfProgress: 'largefiles:progress',
  lfQuarantine: 'largefiles:quarantine',
  lfDelete: 'largefiles:delete',
  lfReveal: 'largefiles:reveal',
  quarantineList: 'quarantine:list',
  quarantineRestore: 'quarantine:restore',
  quarantineRemove: 'quarantine:remove',
  historyList: 'history:list',
} as const;
