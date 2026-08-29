import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { currentClockSeconds, formatMatchdayClock, type MatchdayState } from "./domain/matchday";

export interface TxtFileNames {
  homeName: string;
  homeScore: string;
  awayName: string;
  awayScore: string;
  clock: string;
}

export const DEFAULT_TXT_FILES: TxtFileNames = {
  homeName: "Home Name.txt",
  homeScore: "Home Score.txt",
  awayName: "Away Name.txt",
  awayScore: "Away Score.txt",
  clock: "Clock.txt",
};

/**
 * Grava os 5 ficheiros `.txt` do marcador:
 * UTF-8, escrita atómica (temp + rename), só escreve quando o valor muda.
 */
export class TxtWriter {
  readonly outputDir: string;
  readonly files: TxtFileNames;
  private readonly last = new Map<string, string>();
  private readonly failed = new Set<keyof TxtFileNames>();
  private lastErrorValue: string | null = null;
  private lastWriteAtValue: number | null = null;

  constructor(outputDir: string, files: TxtFileNames = DEFAULT_TXT_FILES) {
    this.outputDir = outputDir;
    this.files = files;
    try {
      mkdirSync(outputDir, { recursive: true });
    } catch {
      // Pasta inválida/não escrevível: o probe/escritas reportam o erro.
    }
  }

  /** Verifica (e cria) a pasta de saída. Lança se não for escrevível. */
  probe(): void {
    const probePath = join(this.outputDir, ".matchday-write-test");
    writeFileSync(probePath, "ok", { encoding: "utf8", flag: "w" });
    unlinkSync(probePath);
  }

  get lastError(): string | null {
    return this.lastErrorValue;
  }

  get lastWriteAt(): number | null {
    return this.lastWriteAtValue;
  }

  /** Último valor que nós escrevemos para um ficheiro (undefined = nunca). */
  lastValue(key: keyof TxtFileNames): string | undefined {
    return this.last.get(key);
  }

  /** Reescreve os ficheiros cujo valor mudou; force=true reescreve todos. */
  writeState(state: MatchdayState, nowMs = Date.now(), force = false): boolean {
    const values: Record<keyof TxtFileNames, string> = {
      homeName: state.homeTeam,
      homeScore: String(state.homeScore),
      awayName: state.awayTeam,
      awayScore: String(state.awayScore),
      clock: formatMatchdayClock(currentClockSeconds(state, nowMs)),
    };
    let ok = true;
    for (const key of Object.keys(values) as Array<keyof TxtFileNames>) {
      if (!force && !this.failed.has(key) && this.last.get(key) === values[key]) continue;
      if (!this.write(key, values[key])) {
        this.failed.add(key);
        ok = false;
      } else {
        this.failed.delete(key);
      }
    }
    if (this.failed.size > 0) ok = false;
    if (ok) this.lastErrorValue = null;
    return ok;
  }

  private write(key: keyof TxtFileNames, value: string): boolean {
    const target = join(this.outputDir, this.files[key]);
    const temp = `${target}.${process.pid}.tmp`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        writeFileSync(temp, value, { encoding: "utf8", flag: "w" });
        renameSync(temp, target);
        this.last.set(key, value);
        this.lastWriteAtValue = Date.now();
        return true;
      } catch {
        try {
          writeFileSync(target, value, { encoding: "utf8", flag: "w" });
          this.last.set(key, value);
          this.lastWriteAtValue = Date.now();
          return true;
        } catch (error) {
          if (attempt === 2) {
            this.lastErrorValue = `Falha a escrever ${this.files[key]}: ${error instanceof Error ? error.message : String(error)}`;
            return false;
          }
        }
      }
    }
    return false;
  }
}
