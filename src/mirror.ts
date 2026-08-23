import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  MATCHDAY_PERIOD_MAX_SECONDS,
  currentClockSeconds,
  type MatchdayState,
} from "./domain/matchday";
import type { MatchdayCommandAction } from "./commands";
import type { TxtFileNames } from "./writer";

export interface TeleScoreStatus {
  enabled: boolean;
  online: boolean;
  lastSeenAt: string | null;
  clockConflict: boolean;
}

export interface TeleScoreMirrorOptions {
  watchDir: string;
  files: TxtFileNames;
  pollMs: number;
  adoptTeams: boolean;
  adoptScores: boolean;
  adoptClock: boolean;
  processName: string | null;
  getState: () => MatchdayState | null;
  ownValue: (key: keyof TxtFileNames) => string | undefined;
  invalidateFile?: (key: keyof TxtFileNames) => void;
  applyActions: (actions: MatchdayCommandAction[]) => void;
  now?: () => number;
}

const FILE_KEYS: Array<keyof TxtFileNames> = ["homeName", "homeScore", "awayName", "awayScore", "clock"];
const PROCESS_CHECK_MS = 2_000;
const ONLINE_ACTIVITY_MS = 10_000;
const CONFLICT_RESET_MS = 3_000;

interface SeenFile {
  content: string | null;
  mtimeMs: number;
}

/**
 * Espelho do TeleScore: vigia os 5 ficheiros `.txt` na pasta partilhada e
 * adota alterações externas (equipas/resultado/relógio) para o estado do
 * MatchdayControl. O app mantém-se a autoridade do relógio: quando o nosso
 * relógio está a correr, o Clock.txt externo é ignorado e sinalizado como
 * conflito; as nossas escritas são sempre ignoradas pelo próprio espelho.
 */
export class TeleScoreMirror {
  private readonly watchDir: string;
  private readonly files: TxtFileNames;
  private readonly pollMs: number;
  private readonly adoptTeams: boolean;
  private readonly adoptScores: boolean;
  private readonly adoptClock: boolean;
  private readonly processName: string | null;
  private readonly getState: () => MatchdayState | null;
  private readonly ownValue: (key: keyof TxtFileNames) => string | undefined;
  private readonly invalidateFile: (key: keyof TxtFileNames) => void;
  private readonly applyActions: (actions: MatchdayCommandAction[]) => void;
  private readonly now: () => number;

  private readonly seen = new Map<keyof TxtFileNames, SeenFile>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private processOnline = false;
  private lastProcessCheck = 0;
  private lastExternalAt = 0;
  private lastClockChangeAt = 0;

  constructor(options: TeleScoreMirrorOptions) {
    this.watchDir = options.watchDir;
    this.files = options.files;
    this.pollMs = options.pollMs;
    this.adoptTeams = options.adoptTeams;
    this.adoptScores = options.adoptScores;
    this.adoptClock = options.adoptClock;
    this.processName = options.processName;
    this.getState = options.getState;
    this.ownValue = options.ownValue;
    this.invalidateFile = options.invalidateFile ?? (() => {});
    this.applyActions = options.applyActions;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => this.pollOnce(), this.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Reconcilição única (usada no arranque, antes de escrever diferenças). */
  reconcileOnce(): void {
    this.pollOnce();
  }

  getStatus(): TeleScoreStatus {
    const now = this.now();
    const state = this.getState();
    return {
      enabled: true,
      online: this.processName
        ? this.processOnline
        : this.lastExternalAt > 0 && now - this.lastExternalAt < ONLINE_ACTIVITY_MS,
      lastSeenAt: this.lastExternalAt > 0 ? new Date(this.lastExternalAt).toISOString() : null,
      clockConflict:
        state?.clockRunning === true &&
        this.lastClockChangeAt > 0 && now - this.lastClockChangeAt < CONFLICT_RESET_MS,
    };
  }

  pollOnce(): void {
    const now = this.now();
    const state = this.getState();
    this.checkProcess(now);

    const actions: MatchdayCommandAction[] = [];
    let externalChange = false;
    let clockExternal = false;

    for (const key of FILE_KEYS) {
      const path = join(this.watchDir, this.files[key]);
      let content: string | null = null;
      let mtimeMs = 0;
      try {
        content = readFileSync(path, "utf8");
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        content = null;
        mtimeMs = 0;
      }

      const prev = this.seen.get(key);
      this.seen.set(key, { content, mtimeMs });

      if (content === null || !state) continue;
      const firstSight = prev === undefined;
      if (!firstSight && prev.content === content && prev.mtimeMs === mtimeMs) continue;

      const own = this.ownValue(key);
      // Escritas nossas: ignoradas (exceto na primeira leitura, onde não se
      // sabe ainda o que é nosso — a adoção de valores iguais é no-op).
      if (!firstSight && content === own) continue;

      const stateMs = Date.parse(state.updatedAt);
      if (!Number.isFinite(stateMs) || mtimeMs <= stateMs) continue;

      externalChange = true;
      if (key === "homeName" || key === "awayName") {
        const text = content.trim();
        if (text) this.collectTeamAction(key, text, state, actions);
      } else if (key === "homeScore" || key === "awayScore") {
        const score = parseScore(content);
        if (score !== null && this.adoptScores) {
          const side = key === "homeScore" ? "home" : "away";
          if (score !== (side === "home" ? state.homeScore : state.awayScore)) {
            actions.push({ type: "SET_SCORE", side, score });
          }
        }
      } else if (key === "clock") {
        clockExternal = true;
        if (state.clockRunning) {
          this.lastClockChangeAt = now;
          // Push-back: obriga a nossa escrita a repor o valor no ficheiro.
          this.invalidateFile("clock");
        } else {
          const seconds = parseClock(content);
          if (seconds !== null && this.adoptClock) {
            const clamped = Math.min(MATCHDAY_PERIOD_MAX_SECONDS[state.period], seconds);
            if (clamped !== currentClockSeconds(state, now)) {
              actions.push({ type: "SET_CLOCK", seconds: clamped });
            }
          }
        }
      }
    }

    if (externalChange) this.lastExternalAt = now;
    if (clockExternal) this.lastClockChangeAt = now;
    if (actions.length > 0) this.applyActions(actions);
  }

  private collectTeamAction(
    key: "homeName" | "awayName",
    text: string,
    state: MatchdayState,
    actions: MatchdayCommandAction[],
  ): void {
    if (!this.adoptTeams) return;
    const side = key === "homeName" ? "home" : "away";
    const current = side === "home" ? state.homeTeam : state.awayTeam;
    if (text === current) return;
    // Se já houver uma ação de equipas nesta passada, combina os dois nomes.
    const existing = actions.find((action) => action.type === "SET_TEAMS") as
      | { type: "SET_TEAMS"; homeTeam: string; awayTeam: string }
      | undefined;
    if (existing) {
      if (side === "home") existing.homeTeam = text;
      else existing.awayTeam = text;
      return;
    }
    actions.push({
      type: "SET_TEAMS",
      homeTeam: side === "home" ? text : state.homeTeam,
      awayTeam: side === "away" ? text : state.awayTeam,
    });
  }

  private checkProcess(now: number): void {
    if (!this.processName || now - this.lastProcessCheck < PROCESS_CHECK_MS) return;
    this.lastProcessCheck = now;
    this.processOnline = processImageAlive(this.processName);
  }
}

function parseScore(content: string): number | null {
  const value = Number(content.trim());
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function parseClock(content: string): number | null {
  const match = content.trim().match(/^(\d{1,3}):(\d{2})$/);
  if (!match) return null;
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || seconds > 59) return null;
  return minutes * 60 + seconds;
}

function processImageAlive(name: string): boolean {
  try {
    const result = Bun.spawnSync(["tasklist", "/FI", `IMAGENAME eq ${name}`, "/NH"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return result.stdout.toString().toLowerCase().includes(name.toLowerCase());
  } catch {
    return false;
  }
}
