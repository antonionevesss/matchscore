import {
  MATCHDAY_HISTORY_LIMIT,
  MATCHDAY_PERIODS,
  applyMatchdayAction,
  matchdayValuesChanged,
  type MatchdayAction,
  type MatchdayState,
} from "./domain/matchday";

export type MatchdayCommandAction = MatchdayAction | { type: "UNDO" };

export function isMatchdayCommandAction(value: unknown): value is MatchdayCommandAction {
  if (!value || typeof value !== "object") return false;
  const action = value as Record<string, unknown>;
  switch (action.type) {
    case "START_CLOCK":
    case "PAUSE_CLOCK":
    case "SWITCH_SIDES":
    case "RESET":
    case "UNDO":
      return true;
    case "SET_CLOCK":
      return typeof action.seconds === "number" && Number.isFinite(action.seconds);
    case "ADJUST_CLOCK":
      return (
        typeof action.deltaSeconds === "number" &&
        Number.isInteger(action.deltaSeconds) &&
        Math.abs(action.deltaSeconds) <= 3600
      );
    case "SCORE":
      return (action.side === "home" || action.side === "away") && (action.delta === 1 || action.delta === -1);
    case "SET_SCORE":
      return (
        (action.side === "home" || action.side === "away") &&
        typeof action.score === "number" &&
        Number.isFinite(action.score)
      );
    case "SET_PERIOD":
      return MATCHDAY_PERIODS.includes(action.period as (typeof MATCHDAY_PERIODS)[number]);
    case "SET_TEAMS":
      return typeof action.homeTeam === "string" && typeof action.awayTeam === "string";
    default:
      return false;
  }
}

export interface CommandResult {
  state: MatchdayState;
  history: MatchdayState[];
  applied: boolean;
}

/**
 * Aplica um comando com as mesmas semânticas do Torre de Controlo:
 * - ações sem efeito não avançam a versão nem escrevem ficheiros;
 * - UNDO repõe o último estado do histórico (sem o voltar a empurrar);
 * - RESET limpa o histórico (não é anulável);
 * - as restantes ações empurram o estado atual para o histórico (máx. 30).
 */
export function applyCommand(
  current: MatchdayState,
  history: MatchdayState[],
  action: MatchdayCommandAction,
  nowIso = new Date().toISOString(),
): CommandResult {
  if (action.type === "UNDO") {
    const previous = history[0];
    if (!previous) return { state: current, history, applied: false };
    const next: MatchdayState = {
      ...previous,
      updatedAt: nowIso,
      version: current.version + 1,
    };
    return { state: next, history: history.slice(1), applied: true };
  }

  const next = applyMatchdayAction(current, action, nowIso);
  if (!matchdayValuesChanged(current, next)) {
    return { state: current, history, applied: false };
  }
  const nextState: MatchdayState = { ...next, version: current.version + 1 };
  const nextHistory =
    action.type === "RESET" ? [] : [current, ...history].slice(0, MATCHDAY_HISTORY_LIMIT);
  return { state: nextState, history: nextHistory, applied: true };
}
