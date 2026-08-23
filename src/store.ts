import { Database } from "bun:sqlite";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { isMatchdayState, type MatchdayState } from "./domain/matchday";

export interface PersistedSession {
  state: MatchdayState | null;
  history: MatchdayState[];
}

export class ConflictError extends Error {
  constructor() {
    super("O estado mudou noutro dispositivo.");
    this.name = "ConflictError";
  }
}

export class MatchdayStore {
  readonly dbPath: string;
  readonly backupPaths: [string, string];
  private db: Database;

  private constructor(dbPath: string, backupPaths: [string, string]) {
    this.dbPath = dbPath;
    this.backupPaths = backupPaths;
    this.db = openDatabase(dbPath);
    migrate(this.db);
  }

  static open(dbPath: string): { store: MatchdayStore; restoredFromBackup: boolean; startupError: string | null } {
    const backupPaths: [string, string] = [`${dbPath}.bak`, `${dbPath}.bak2`];
    mkdirSync(dirname(dbPath), { recursive: true });

    let startupError: string | null = null;
    let restoredFromBackup = false;
    if (!isDatabaseUsable(dbPath)) {
      startupError = "Base de dados corrompida ou estado persistido inválido.";
      if (restoreFromBackup(dbPath, backupPaths)) {
        restoredFromBackup = true;
        console.warn(`[store] ${startupError} Restaurado do backup.`);
      } else {
        console.error(`[store] ${startupError} Sem backup válido; a recomeçar vazio.`);
        // Não apaga nada: guarda o ficheiro corrompido à parte para diagnóstico.
        try {
          renameSync(dbPath, `${dbPath}.corrupt`);
        } catch {
          try {
            unlinkSync(dbPath);
          } catch {
            // já não existe
          }
        }
        for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
          try {
            unlinkSync(sidecar);
          } catch {
            // não existe
          }
        }
      }
    }

    return { store: new MatchdayStore(dbPath, backupPaths), restoredFromBackup, startupError };
  }

  load(): PersistedSession {
    const row = this.db.query("SELECT state_json, history_json FROM state WHERE id = 1").get() as
      | { state_json: string; history_json: string }
      | null;
    if (!row) return { state: null, history: [] };
    let state: MatchdayState | null = null;
    try {
      const parsed = JSON.parse(row.state_json) as unknown;
      if (isMatchdayState(parsed)) state = parsed;
    } catch {
      state = null;
    }
    let history: MatchdayState[] = [];
    try {
      const parsed = JSON.parse(row.history_json) as unknown;
      if (Array.isArray(parsed)) history = parsed.filter(isMatchdayState);
    } catch {
      history = [];
    }
    return { state, history };
  }

  /**
   * Persiste o próximo estado numa transação. O estado passado deve ter
   * version = version persistida + 1; caso contrário lança ConflictError.
   */
  commit(state: MatchdayState, history: MatchdayState[]): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const row = this.db.query("SELECT version FROM state WHERE id = 1").get() as { version: number } | null;
      if (row && row.version !== state.version - 1) {
        throw new ConflictError();
      }
      if (row) {
        this.db
          .query(
            `UPDATE state
             SET state_json = ?, history_json = ?, version = ?, updated_at = ?
             WHERE id = 1`,
          )
          .run(JSON.stringify(state), JSON.stringify(history), state.version, now);
      } else {
        this.db
          .query(
            `INSERT INTO state (id, state_json, history_json, version, updated_at)
             VALUES (1, ?, ?, ?, ?)`,
          )
          .run(JSON.stringify(state), JSON.stringify(history), state.version, now);
      }
    })();
    this.rotateBackup();
  }

  /** Snapshot VACUUM INTO (seguro com WAL) para o backup rotativo. */
  private rotateBackup(): void {
    try {
      const [primary, secondary] = this.backupPaths;
      const temp = `${primary}.tmp`;
      this.db.query(`VACUUM INTO '${temp.replaceAll("'", "''")}'`).run();
      if (existsSync(secondary)) unlinkSync(secondary);
      if (existsSync(primary)) renameSync(primary, secondary);
      renameSync(temp, primary);
    } catch {
      // Backup falhou: o estado principal já está persistido; não derruba o processo.
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // já fechada
    }
  }
}

function openDatabase(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

function isDatabaseUsable(dbPath: string): boolean {
  if (!existsSync(dbPath)) return true; // primeiro arranque: cria de raiz
  if (!looksLikeSqlite(dbPath)) return false;
  let probe: Database | null = null;
  try {
    probe = openDatabase(dbPath);
    migrate(probe);
    const row = probe.query("SELECT state_json FROM state WHERE id = 1").get() as { state_json: string } | null;
    if (row) {
      const parsed = JSON.parse(row.state_json) as unknown;
      if (!isMatchdayState(parsed)) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    probe?.close();
  }
}

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS state (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      state_json  TEXT NOT NULL,
      history_json TEXT NOT NULL DEFAULT '[]',
      version     INTEGER NOT NULL,
      updated_at  TEXT NOT NULL
    );
  `);
}

function restoreFromBackup(dbPath: string, backups: [string, string]): boolean {
  for (const backup of backups) {
    if (!existsSync(backup)) continue;
    if (!looksLikeSqlite(backup)) continue;
    try {
      const candidate = openDatabase(backup);
      const row = candidate.query("SELECT state_json FROM state WHERE id = 1").get() as
        | { state_json: string }
        | null;
      const valid = !row || isMatchdayState(JSON.parse(row.state_json));
      candidate.close();
      if (!valid) continue;
      copyFileSync(backup, dbPath);
      // Remove sidecars WAL antigos para não contaminarem o ficheiro restaurado.
      for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          unlinkSync(sidecar);
        } catch {
          // não existe
        }
      }
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * Previne a abertura de ficheiros que não são SQLite: o bun:sqlite no Windows
 * deixa um handle aberto quando o construtor falha em ficheiros corrompidos.
 */
function looksLikeSqlite(path: string): boolean {
  try {
    const stat = statSync(path);
    if (stat.size === 0) return true;
    if (stat.size < 16) return false;
    const handle = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(16);
      const bytes = readSync(handle, buffer, 0, 16, 0);
      return bytes === 16 && buffer.toString("latin1") === "SQLite format 3\u0000";
    } finally {
      closeSync(handle);
    }
  } catch {
    return false;
  }
}
