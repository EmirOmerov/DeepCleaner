import * as fs from 'node:fs';
import * as path from 'node:path';

export type HistoryAction = 'quarantine' | 'restore' | 'delete' | 'purge' | 'clean' | 'uninstall';

export interface HistoryEntry {
  ts: string;
  action: HistoryAction;
  module: string;
  items: number;
  bytes: number;
  failed: number;
  /** A few sample paths so the user can see what was touched. */
  sample?: string[];
}

/** Append-only JSONL log of every destructive action. */
export class HistoryLog {
  constructor(private readonly file: string) {}

  append(entry: Omit<HistoryEntry, 'ts'>, now: Date = new Date()): HistoryEntry {
    const full: HistoryEntry = { ts: now.toISOString(), ...entry };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(full) + '\n', 'utf8');
    return full;
  }

  /** Newest first. Corrupt lines are skipped rather than failing the whole read. */
  read(limit = 200): HistoryEntry[] {
    if (!fs.existsSync(this.file)) return [];
    const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
    const out: HistoryEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        out.push(JSON.parse(lines[i]) as HistoryEntry);
      } catch {
        /* skip corrupt line */
      }
    }
    return out;
  }
}
