export const MATCHDAY_PERIODS = [
  "PRE_MATCH",
  "FIRST_HALF",
  "HALF_TIME",
  "SECOND_HALF",
  "EXTRA_FIRST_HALF",
  "EXTRA_HALF_TIME",
  "EXTRA_SECOND_HALF",
  "FULL_TIME",
  "EXTRA_FULL_TIME",
] as const;
export type MatchdayPeriod = (typeof MATCHDAY_PERIODS)[number];

/**
 * Períodos em que o relógio pode correr (os restantes são paragens).
 */
const MATCHDAY_PLAYING_PERIODS: readonly MatchdayPeriod[] = [
  "FIRST_HALF",
  "SECOND_HALF",
  "EXTRA_FIRST_HALF",
  "EXTRA_SECOND_HALF",
];

export function isPlayingPeriod(period: MatchdayPeriod): boolean {
  return MATCHDAY_PLAYING_PERIODS.includes(period);
}

const FIRST_HALF_SECONDS = 45 * 60;
const REGULAR_MATCH_SECONDS = 90 * 60;
const EXTRA_FIRST_HALF_SECONDS = 105 * 60;
const EXTRA_MATCH_SECONDS = 120 * 60;

/**
 * Limite absoluto de cada período — o relógio nunca passa daqui
 * (proibido pela liga).
 */
export const MATCHDAY_PERIOD_MAX_SECONDS: Record<MatchdayPeriod, number> = {
  PRE_MATCH: 0,
  FIRST_HALF: FIRST_HALF_SECONDS,
  HALF_TIME: FIRST_HALF_SECONDS,
  SECOND_HALF: REGULAR_MATCH_SECONDS,
  EXTRA_FIRST_HALF: EXTRA_FIRST_HALF_SECONDS,
  EXTRA_HALF_TIME: EXTRA_FIRST_HALF_SECONDS,
  EXTRA_SECOND_HALF: EXTRA_MATCH_SECONDS,
  FULL_TIME: REGULAR_MATCH_SECONDS,
  EXTRA_FULL_TIME: EXTRA_MATCH_SECONDS,
};

interface PeriodTransition {
  baseSeconds: number;
  running: boolean;
  repeatBaseSeconds?: number;
}

const PERIOD_TRANSITIONS: Record<MatchdayPeriod, PeriodTransition> = {
  PRE_MATCH: { baseSeconds: 0, running: false },
  FIRST_HALF: { baseSeconds: 0, running: false },
  HALF_TIME: { baseSeconds: FIRST_HALF_SECONDS, running: false, repeatBaseSeconds: FIRST_HALF_SECONDS },
  SECOND_HALF: { baseSeconds: FIRST_HALF_SECONDS, running: true, repeatBaseSeconds: FIRST_HALF_SECONDS },
  EXTRA_FIRST_HALF: { baseSeconds: REGULAR_MATCH_SECONDS, running: true, repeatBaseSeconds: REGULAR_MATCH_SECONDS },
  EXTRA_HALF_TIME: { baseSeconds: EXTRA_FIRST_HALF_SECONDS, running: false, repeatBaseSeconds: EXTRA_FIRST_HALF_SECONDS },
  EXTRA_SECOND_HALF: { baseSeconds: EXTRA_FIRST_HALF_SECONDS, running: true, repeatBaseSeconds: EXTRA_FIRST_HALF_SECONDS },
  FULL_TIME: { baseSeconds: REGULAR_MATCH_SECONDS, running: false, repeatBaseSeconds: REGULAR_MATCH_SECONDS },
  EXTRA_FULL_TIME: { baseSeconds: EXTRA_MATCH_SECONDS, running: false, repeatBaseSeconds: EXTRA_MATCH_SECONDS },
};

export const MATCHDAY_HISTORY_LIMIT = 30;

export interface MatchdayState {
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  period: MatchdayPeriod;
  clockBaseSeconds: number;
  clockRunning: boolean;
  clockStartedAt: string | null;
  updatedAt: string;
  version: number;
}

export type MatchdayAction =
  | { type: "START_CLOCK" }
  | { type: "PAUSE_CLOCK" }
  | { type: "SET_CLOCK"; seconds: number }
  | { type: "ADJUST_CLOCK"; deltaSeconds: number }
  | { type: "SCORE"; side: "home" | "away"; delta: 1 | -1 }
  | { type: "SET_SCORE"; side: "home" | "away"; score: number }
  | { type: "SET_PERIOD"; period: MatchdayPeriod }
  | { type: "SET_TEAMS"; homeTeam: string; awayTeam: string }
  | { type: "SWITCH_SIDES" }
  | { type: "RESET" };

/**
 * Nome usado no marcador: maiúsculas, espaços normais, sem espaços nas pontas.
 */
export function normalizeTeamName(name: string): string {
  return String(name ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase()
    .slice(0, 48);
}

/**
 * Estado inicial criado pelo setup manual (só com os nomes das equipas).
 */
export function createInitialState(
  homeTeam: string,
  awayTeam: string,
  nowIso = new Date().toISOString(),
): MatchdayState {
  return {
    homeTeam: normalizeTeamName(homeTeam),
    awayTeam: normalizeTeamName(awayTeam),
    homeScore: 0,
    awayScore: 0,
    period: "PRE_MATCH",
    clockBaseSeconds: 0,
    clockRunning: false,
    clockStartedAt: null,
    updatedAt: nowIso,
    version: 1,
  };
}

/**
 * O relógio nunca depende de updates por segundo: o valor atual é derivado
 * do base + tempo decorrido desde clockStartedAt, e é sempre limitado ao
 * máximo do período em curso.
 */
export function currentClockSeconds(state: MatchdayState, nowMs = Date.now()): number {
  const startedAt = state.clockStartedAt ? Date.parse(state.clockStartedAt) : Number.NaN;
  const elapsed =
    state.clockRunning && Number.isFinite(startedAt)
      ? Math.max(0, Math.floor((nowMs - startedAt) / 1000))
      : 0;
  const max = MATCHDAY_PERIOD_MAX_SECONDS[state.period];
  return Math.min(max, state.clockBaseSeconds + elapsed);
}

export function formatMatchdayClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/**
 * Aplica uma ação ao estado atual. Ação sem efeito devolve o mesmo objeto,
 * para que o servidor não avance a versão nem escreva ficheiros à toa.
 */
export function applyMatchdayAction(
  state: MatchdayState,
  action: MatchdayAction,
  nowIso = new Date().toISOString(),
): MatchdayState {
  const nowMs = Date.parse(nowIso);
  switch (action.type) {
    case "START_CLOCK": {
      if (state.clockRunning) return state;
      if (!isPlayingPeriod(state.period)) return state;
      if (currentClockSeconds(state, nowMs) >= MATCHDAY_PERIOD_MAX_SECONDS[state.period]) return state;
      return { ...state, clockRunning: true, clockStartedAt: nowIso, updatedAt: nowIso };
    }
    case "PAUSE_CLOCK": {
      if (!state.clockRunning) return state;
      return {
        ...state,
        clockBaseSeconds: currentClockSeconds(state, nowMs),
        clockRunning: false,
        clockStartedAt: null,
        updatedAt: nowIso,
      };
    }
    case "SET_CLOCK": {
      const max = MATCHDAY_PERIOD_MAX_SECONDS[state.period];
      const seconds = Math.min(max, Math.max(0, Math.floor(action.seconds)));
      if (seconds === currentClockSeconds(state, nowMs)) return state;
      return {
        ...state,
        clockBaseSeconds: seconds,
        clockStartedAt: state.clockRunning ? nowIso : null,
        updatedAt: nowIso,
      };
    }
    case "ADJUST_CLOCK": {
      const max = MATCHDAY_PERIOD_MAX_SECONDS[state.period];
      const current = currentClockSeconds(state, nowMs);
      const seconds = Math.min(max, Math.max(0, Math.floor(current + action.deltaSeconds)));
      if (seconds === current) return state;
      const clockRunning = state.clockRunning && seconds < max;
      return {
        ...state,
        clockBaseSeconds: seconds,
        clockRunning,
        clockStartedAt: clockRunning ? nowIso : null,
        updatedAt: nowIso,
      };
    }
    case "SCORE": {
      const score = action.side === "home" ? state.homeScore : state.awayScore;
      const nextScore = Math.max(0, score + action.delta);
      if (nextScore === score) return state;
      return action.side === "home"
        ? { ...state, homeScore: nextScore, updatedAt: nowIso }
        : { ...state, awayScore: nextScore, updatedAt: nowIso };
    }
    case "SET_SCORE": {
      const score = Math.max(0, Math.floor(action.score));
      const current = action.side === "home" ? state.homeScore : state.awayScore;
      if (score === current) return state;
      return action.side === "home"
        ? { ...state, homeScore: score, updatedAt: nowIso }
        : { ...state, awayScore: score, updatedAt: nowIso };
    }
    case "SET_PERIOD": {
      if (action.period === state.period) {
        const fixedSeconds = PERIOD_TRANSITIONS[action.period].repeatBaseSeconds;
        if (
          fixedSeconds === undefined ||
          state.clockBaseSeconds === fixedSeconds &&
            !state.clockRunning &&
            state.clockStartedAt === null
        ) {
          return state;
        }
        return {
          ...state,
          clockBaseSeconds: fixedSeconds,
          clockRunning: false,
          clockStartedAt: null,
          updatedAt: nowIso,
        };
      }
      const transition = PERIOD_TRANSITIONS[action.period];
      return {
        ...state,
        period: action.period,
        clockBaseSeconds: transition.baseSeconds,
        clockRunning: transition.running,
        clockStartedAt: transition.running ? nowIso : null,
        updatedAt: nowIso,
      };
    }
    case "SET_TEAMS": {
      const homeTeam = normalizeTeamName(action.homeTeam);
      const awayTeam = normalizeTeamName(action.awayTeam);
      if (homeTeam === state.homeTeam && awayTeam === state.awayTeam) return state;
      return { ...state, homeTeam, awayTeam, updatedAt: nowIso };
    }
    case "SWITCH_SIDES": {
      if (state.homeTeam === state.awayTeam) return state;
      return { ...state, homeTeam: state.awayTeam, awayTeam: state.homeTeam, updatedAt: nowIso };
    }
    case "RESET": {
      const next: MatchdayState = {
        ...state,
        homeScore: 0,
        awayScore: 0,
        period: "PRE_MATCH",
        clockBaseSeconds: 0,
        clockRunning: false,
        clockStartedAt: null,
        updatedAt: nowIso,
      };
      return matchdayValuesChanged(state, next) ? next : state;
    }
  }
}

/**
 * Compara apenas os campos de conteúdo (ignora updatedAt e version), para
 * detetar ações sem efeito real no marcador.
 */
export function matchdayValuesChanged(a: MatchdayState, b: MatchdayState): boolean {
  return !(
    a.homeTeam === b.homeTeam &&
    a.awayTeam === b.awayTeam &&
    a.homeScore === b.homeScore &&
    a.awayScore === b.awayScore &&
    a.period === b.period &&
    a.clockBaseSeconds === b.clockBaseSeconds &&
    a.clockRunning === b.clockRunning &&
    a.clockStartedAt === b.clockStartedAt
  );
}

/**
 * Validação defensiva de um estado carregado da base de dados.
 * Campos antigos (matchId, addedTimeMinutes) são tolerados.
 */
export function isMatchdayState(value: unknown): value is MatchdayState {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.homeTeam === "string" &&
    typeof s.awayTeam === "string" &&
    typeof s.homeScore === "number" &&
    Number.isFinite(s.homeScore) &&
    s.homeScore >= 0 &&
    typeof s.awayScore === "number" &&
    Number.isFinite(s.awayScore) &&
    s.awayScore >= 0 &&
    MATCHDAY_PERIODS.includes(s.period as MatchdayPeriod) &&
    typeof s.clockBaseSeconds === "number" &&
    Number.isFinite(s.clockBaseSeconds) &&
    s.clockBaseSeconds >= 0 &&
    typeof s.clockRunning === "boolean" &&
    (s.clockStartedAt === null || typeof s.clockStartedAt === "string") &&
    typeof s.updatedAt === "string" &&
    typeof s.version === "number" &&
    Number.isInteger(s.version) &&
    s.version >= 1
  );
}
