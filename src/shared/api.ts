/**
 * The typed contract between the renderer and the main process.
 * The renderer never sees Node APIs — only this surface, via contextBridge.
 */
import type { CleanReport, TargetScan } from '../core/cache/cacheCleaner';
import type { ImageGroup, ImageMetrics, ScoredImage } from '../core/images/grouping';
import type { ImageScanProgress } from '../core/images/imageScanner';
import type { FileCategory, LargeFile, ScanProgress } from '../core/largefiles/largeFiles';
import type { HistoryEntry } from '../core/quarantine/history';
import type { OpResult, QuarantineItem } from '../core/quarantine/quarantine';
import type { Leftover } from '../core/uninstall/leftovers';
import type { InstalledProgram } from '../core/uninstall/programs';

export type {
  CleanReport,
  FileCategory,
  HistoryEntry,
  ImageGroup,
  ImageMetrics,
  ImageScanProgress,
  InstalledProgram,
  LargeFile,
  Leftover,
  OpResult,
  QuarantineItem,
  ScanProgress,
  ScoredImage,
  TargetScan,
};

export interface UninstallOutcome {
  exitCode: number;
  /** User declined the UAC prompt. */
  cancelled: boolean;
  error?: string;
  /** The program's registry entry still exists after the uninstaller exited. */
  stillInstalled: boolean;
}

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
  images: {
    defaultRoots(): Promise<string[]>;
    scan(roots: string[], minSimilarity: number): Promise<ImageGroup[]>;
    /** Re-group the last scan with a new threshold (no re-analysis). */
    regroup(minSimilarity: number): Promise<ImageGroup[]>;
    cancel(): Promise<void>;
    onProgress(cb: (p: ImageScanProgress) => void): () => void;
    /** JPEG data URL, only for images from the current groups. */
    preview(path: string, maxSize: number): Promise<string | null>;
    quarantine(paths: string[]): Promise<OpResult>;
    reveal(path: string): Promise<void>;
  };
  programs: {
    list(): Promise<InstalledProgram[]>;
    /** Runs the program's own uninstaller and waits for it. */
    uninstall(id: string): Promise<UninstallOutcome>;
    isInstalled(id: string): Promise<boolean>;
    /** Refused while the program is still installed. */
    leftovers(id: string): Promise<Leftover[]>;
    /** Files go to quarantine; registry keys are backed up to .reg first. */
    removeLeftovers(id: string, paths: string[]): Promise<OpResult>;
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
  imgDefaultRoots: 'images:default-roots',
  imgScan: 'images:scan',
  imgRegroup: 'images:regroup',
  imgCancel: 'images:cancel',
  imgProgress: 'images:progress',
  imgPreview: 'images:preview',
  imgQuarantine: 'images:quarantine',
  imgReveal: 'images:reveal',
  programsList: 'programs:list',
  programsUninstall: 'programs:uninstall',
  programsIsInstalled: 'programs:is-installed',
  programsLeftovers: 'programs:leftovers',
  programsRemoveLeftovers: 'programs:remove-leftovers',
  quarantineList: 'quarantine:list',
  quarantineRestore: 'quarantine:restore',
  quarantineRemove: 'quarantine:remove',
  historyList: 'history:list',
} as const;
