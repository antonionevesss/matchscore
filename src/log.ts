import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export type LogCategory = "system" | "obs" | "projector" | "match";
export type LogLevel = "info" | "success" | "warning" | "error";

export interface AppLogEvent {
  category: LogCategory;
  level: LogLevel;
  message: string;
}

export interface LogEntry extends AppLogEvent {
  id: number;
  at: string;
}

export interface LogQuery {
  limit?: number;
  category?: LogCategory;
  level?: LogLevel;
  query?: string;
}

export interface LogList {
  logs: LogEntry[];
  total: number;
}

const DEFAULT_MAX_ENTRIES = 1_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

export function isLogCategory(value: unknown): value is LogCategory {
  return value === "system" || value === "obs" || value === "projector" || value === "match";
}

export function isLogLevel(value: unknown): value is LogLevel {
  return value === "info" || value === "success" || value === "warning" || value === "error";
}

function validEntry(value: unknown): value is LogEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return Number.isInteger(entry.id) && Number(entry.id) > 0
    && typeof entry.at === "string" && Number.isFinite(Date.parse(entry.at))
    && isLogCategory(entry.category) && isLogLevel(entry.level)
    && typeof entry.message === "string";
}

/**
 * Small JSONL-backed event store for the operational panel. The diagnostic
 * console log remains separate; this store contains structured events that
 * can be filtered and exported from the webapp.
 */
export class PersistentLogStore {
  private readonly entries: LogEntry[];
  private nextId = 1;

  constructor(
    private readonly filePath: string,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
  ) {
    this.entries = this.load();
    const lastId = this.entries.reduce((highest, entry) => Math.max(highest, entry.id), 0);
    this.nextId = lastId + 1;
  }

  add(event: AppLogEvent, at = new Date().toISOString()): LogEntry {
    const entry: LogEntry = { ...event, id: this.nextId, at };
    this.nextId += 1;
    this.entries.push(entry);
    this.trim();
    this.persist(entry);
    return entry;
  }

  list(query: LogQuery = {}): LogList {
    const search = query.query?.trim().toLocaleLowerCase();
    const filtered = this.entries.filter((entry) => {
      if (query.category && entry.category !== query.category) return false;
      if (query.level && entry.level !== query.level) return false;
      if (search && !`${entry.category} ${entry.level} ${entry.message}`.toLocaleLowerCase().includes(search)) return false;
      return true;
    });
    const limit = Number.isInteger(query.limit) && (query.limit ?? 0) > 0
      ? Math.min(query.limit!, this.maxEntries)
      : 100;
    return {
      total: filtered.length,
      logs: filtered.slice(-limit).reverse(),
    };
  }

  exportText(query: Omit<LogQuery, "limit"> = {}): string {
    return this.list({ ...query, limit: this.maxEntries }).logs
      .reverse()
      .map((entry) => `${entry.at}\t${entry.level.toUpperCase()}\t${entry.category.toUpperCase()}\t${entry.message}`)
      .join("\n") + "\n";
  }

  get path(): string {
    return this.filePath;
  }

  private load(): LogEntry[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const lines = readFileSync(this.filePath, "utf8").split(/\r?\n/);
      return lines
        .map((line) => {
          try {
            const value: unknown = JSON.parse(line);
            return validEntry(value) ? value : null;
          } catch {
            return null;
          }
        })
        .filter((entry): entry is LogEntry => entry !== null)
        .slice(-this.maxEntries);
    } catch {
      return [];
    }
  }

  private trim(): void {
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
  }

  private persist(entry: LogEntry): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      if (existsSync(this.filePath) && statSync(this.filePath).size >= MAX_FILE_BYTES) {
        const tempPath = `${this.filePath}.${process.pid}.tmp`;
        writeFileSync(tempPath, this.entries.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
        renameSync(tempPath, this.filePath);
        return;
      }
      appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      // Event persistence is best effort; the in-memory panel must continue.
    }
  }
}
