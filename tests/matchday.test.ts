import assert from "node:assert/strict";
import test from "node:test";
import {
  MATCHDAY_PERIOD_MAX_SECONDS,
  applyMatchdayAction,
  createInitialState,
  currentClockSeconds,
  formatMatchdayClock,
  isPlayingPeriod,
  matchdayValuesChanged,
} from "../src/domain/matchday";

test("estado inicial usa nomes normalizados e versão 1", () => {
  const state = createInitialState("  Home Team ", "away team");
  assert.equal(state.homeTeam, "HOME TEAM");
  assert.equal(state.awayTeam, "AWAY TEAM");
  assert.equal(state.homeScore, 0);
  assert.equal(state.period, "PRE_MATCH");
  assert.equal(state.clockRunning, false);
  assert.equal(state.version, 1);
});

test("o relógio deriva de base + tempo decorrido e pára a contar", () => {
  const start = "2026-08-14T17:00:00.000Z";
  let state = createInitialState("A", "B", start);
  state = applyMatchdayAction(state, { type: "SET_PERIOD", period: "FIRST_HALF" }, start);
  state = applyMatchdayAction(state, { type: "START_CLOCK" }, start);
  assert.equal(state.clockRunning, true);
  assert.equal(currentClockSeconds(state, Date.parse(start) + 4_500), 4);
  state = applyMatchdayAction(state, { type: "PAUSE_CLOCK" }, new Date(Date.parse(start) + 5_500).toISOString());
  assert.equal(state.clockRunning, false);
  assert.equal(state.clockBaseSeconds, 5);
  assert.equal(state.clockStartedAt, null);
  assert.equal(currentClockSeconds(state, Date.parse(start) + 60_000), 5);
});

test("o resultado nunca fica negativo e golo soma", () => {
  let state = createInitialState("A", "B");
  const unchanged = applyMatchdayAction(state, { type: "SCORE", side: "home", delta: -1 });
  assert.equal(unchanged, state);
  state = applyMatchdayAction(state, { type: "SCORE", side: "away", delta: 1 });
  assert.equal(state.awayScore, 1);
  state = applyMatchdayAction(state, { type: "SCORE", side: "away", delta: 1 });
  state = applyMatchdayAction(state, { type: "SCORE", side: "away", delta: -1 });
  assert.equal(state.awayScore, 1);
});

test("SET_SCORE define o resultado diretamente", () => {
  let state = createInitialState("A", "B");
  state = applyMatchdayAction(state, { type: "SET_SCORE", side: "home", score: 3 });
  assert.equal(state.homeScore, 3);
  assert.equal(applyMatchdayAction(state, { type: "SET_SCORE", side: "home", score: 3 }), state);
  state = applyMatchdayAction(state, { type: "SET_SCORE", side: "away", score: -5 });
  assert.equal(state.awayScore, 0);
});

test("períodos seguem o relógio contínuo do jogo (45/90/105/120)", () => {
  const start = "2026-08-14T17:00:00.000Z";
  let state = createInitialState("A", "B", start);

  state = applyMatchdayAction(state, { type: "SET_PERIOD", period: "FIRST_HALF" }, start);
  assert.equal(state.period, "FIRST_HALF");
  assert.equal(state.clockBaseSeconds, 0);
  assert.equal(state.clockRunning, false);

  state = applyMatchdayAction(state, { type: "START_CLOCK" }, start);
  state = applyMatchdayAction(state, { type: "SET_PERIOD", period: "HALF_TIME" }, new Date(Date.parse(start) + 10_000).toISOString());
  assert.equal(state.period, "HALF_TIME");
  assert.equal(state.clockBaseSeconds, 45 * 60);
  assert.equal(state.clockRunning, false);

  state = applyMatchdayAction(state, { type: "SET_PERIOD", period: "SECOND_HALF" }, start);
  assert.equal(state.period, "SECOND_HALF");
  assert.equal(state.clockBaseSeconds, 45 * 60);
  assert.equal(state.clockRunning, true);

  // Fim do 2.º tempo: fixa em 90:00.
  state = applyMatchdayAction(state, { type: "SET_PERIOD", period: "FULL_TIME" }, new Date(Date.parse(start) + 2_000).toISOString());
  assert.equal(state.period, "FULL_TIME");
  assert.equal(state.clockBaseSeconds, 90 * 60);
  assert.equal(state.clockRunning, false);

  // Voltar à 2.ª parte começa sempre no valor regulamentar.
  state = applyMatchdayAction(state, { type: "SET_PERIOD", period: "SECOND_HALF" }, new Date(Date.parse(start) + 2_000).toISOString());
  assert.equal(state.clockBaseSeconds, 45 * 60);
  assert.equal(state.clockRunning, true);

  state = applyMatchdayAction(state, { type: "SET_PERIOD", period: "EXTRA_FIRST_HALF" }, new Date(Date.parse(start) + 4_000).toISOString());
  assert.equal(state.period, "EXTRA_FIRST_HALF");
  assert.equal(state.clockBaseSeconds, 90 * 60);
  assert.equal(state.clockRunning, true);

  state = applyMatchdayAction(state, { type: "SET_PERIOD", period: "EXTRA_HALF_TIME" }, new Date(Date.parse(start) + 7_000).toISOString());
  assert.equal(state.period, "EXTRA_HALF_TIME");
  assert.equal(state.clockBaseSeconds, 105 * 60);
  assert.equal(state.clockRunning, false);

  state = applyMatchdayAction(state, { type: "SET_PERIOD", period: "EXTRA_SECOND_HALF" }, new Date(Date.parse(start) + 7_000).toISOString());
  assert.equal(state.period, "EXTRA_SECOND_HALF");
  assert.equal(state.clockBaseSeconds, 105 * 60);
  assert.equal(state.clockRunning, true);

  // Fim do 2.º pr. de prolongamento: fixa em 120:00.
  state = applyMatchdayAction(state, { type: "SET_PERIOD", period: "EXTRA_FULL_TIME" }, new Date(Date.parse(start) + 9_000).toISOString());
  assert.equal(state.period, "EXTRA_FULL_TIME");
  assert.equal(state.clockBaseSeconds, 120 * 60);
  assert.equal(state.clockRunning, false);
});

test("o relógio nunca passa do limite do período (proibido pela liga)", () => {
  const start = "2026-08-14T17:00:00.000Z";
  let state = createInitialState("A", "B", start);
  state = applyMatchdayAction(state, { type: "SET_PERIOD", period: "FIRST_HALF" }, start);
  state = applyMatchdayAction(state, { type: "START_CLOCK" }, start);

  // 1.ª parte: trava em 45:00 mesmo com muito mais tempo a decorrer.
  assert.equal(currentClockSeconds(state, Date.parse(start) + 4_000_000), 45 * 60);
  state = applyMatchdayAction(state, { type: "PAUSE_CLOCK" }, new Date(Date.parse(start) + 4_000_000).toISOString());
  assert.equal(state.clockBaseSeconds, 45 * 60);
  // Voltar a iniciar no limite não faz nada.
  assert.equal(applyMatchdayAction(state, { type: "START_CLOCK" }, start), state);
  // Definir tempo acima do limite é limitado.
  state = applyMatchdayAction(state, { type: "SET_CLOCK", seconds: 50 * 60 }, start);
  assert.equal(state.clockBaseSeconds, 45 * 60);

  // 2.ª parte: arranca em 45:00 e trava em 90:00.
  state = applyMatchdayAction(state, { type: "SET_PERIOD", period: "SECOND_HALF" }, start);
  assert.equal(currentClockSeconds(state, Date.parse(start) + 4_000_000), 90 * 60);

  // Prolongamento: 1.ª parte trava em 105:00, 2.ª em 120:00.
  state = applyMatchdayAction(state, { type: "SET_PERIOD", period: "EXTRA_FIRST_HALF" }, start);
  assert.equal(currentClockSeconds(state, Date.parse(start) + 4_000_000), 105 * 60);
  state = applyMatchdayAction(state, { type: "SET_PERIOD", period: "EXTRA_SECOND_HALF" }, start);
  assert.equal(currentClockSeconds(state, Date.parse(start) + 4_000_000), 120 * 60);
  // Fim do 2.º tempo: trava em 90:00 mesmo com muito tempo a decorrer.
  state = applyMatchdayAction(state, { type: "SET_PERIOD", period: "SECOND_HALF" }, start);
  assert.equal(currentClockSeconds(state, Date.parse(start) + 4_000_000), 90 * 60);
  state = applyMatchdayAction(state, { type: "SET_PERIOD", period: "FULL_TIME" }, new Date(Date.parse(start) + 4_000_000).toISOString());
  assert.equal(state.clockBaseSeconds, 90 * 60);
  assert.equal(state.clockRunning, false);

  // Fim do prolongamento: em contagem desde 105:00, trava em 120:00.
  state = applyMatchdayAction(state, { type: "SET_PERIOD", period: "EXTRA_SECOND_HALF" }, start);
  assert.equal(currentClockSeconds(state, Date.parse(start) + 4_000_000), 120 * 60);
  state = applyMatchdayAction(state, { type: "SET_PERIOD", period: "EXTRA_FULL_TIME" }, new Date(Date.parse(start) + 4_000_000).toISOString());
  assert.equal(state.clockBaseSeconds, 120 * 60);
  assert.equal(state.clockRunning, false);
});

test("o relógio só pode ser iniciado em períodos de jogo", () => {
  const start = "2026-08-14T17:00:00.000Z";
  assert.equal(isPlayingPeriod("PRE_MATCH"), false);
  assert.equal(isPlayingPeriod("HALF_TIME"), false);
  assert.equal(isPlayingPeriod("FULL_TIME"), false);
  assert.equal(isPlayingPeriod("FIRST_HALF"), true);
  assert.equal(isPlayingPeriod("SECOND_HALF"), true);
  assert.equal(isPlayingPeriod("EXTRA_FIRST_HALF"), true);
  assert.equal(isPlayingPeriod("EXTRA_SECOND_HALF"), true);
  assert.equal(isPlayingPeriod("EXTRA_FULL_TIME"), false);

  let state = createInitialState("A", "B", start);
  assert.equal(applyMatchdayAction(state, { type: "START_CLOCK" }, start), state);
  state = applyMatchdayAction(state, { type: "SET_PERIOD", period: "HALF_TIME" }, start);
  assert.equal(applyMatchdayAction(state, { type: "START_CLOCK" }, start), state);
  state = applyMatchdayAction(state, { type: "SET_PERIOD", period: "FIRST_HALF" }, start);
  assert.notEqual(applyMatchdayAction(state, { type: "START_CLOCK" }, start), state);
});

test("o relógio pode ser corrigido dentro do limite", () => {
  const runningAt = "2026-08-14T17:00:00.000Z";
  let clockState = createInitialState("A", "B", runningAt);
  clockState = applyMatchdayAction(clockState, { type: "SET_PERIOD", period: "FIRST_HALF" }, runningAt);
  clockState = applyMatchdayAction(clockState, { type: "START_CLOCK" }, runningAt);
  clockState = applyMatchdayAction(clockState, { type: "SET_CLOCK", seconds: 2_700 }, new Date(Date.parse(runningAt) + 30_000).toISOString());
  assert.equal(clockState.clockBaseSeconds, 2_700);
  assert.equal(clockState.clockRunning, true);
  assert.equal(currentClockSeconds(clockState, Date.parse(runningAt) + 30_500), 2_700);
});

test("o relógio pode avançar ou recuar segundos sem ultrapassar o período", () => {
  const start = "2026-08-14T17:00:00.000Z";
  let state = createInitialState("A", "B", start);
  state = applyMatchdayAction(state, { type: "SET_PERIOD", period: "FIRST_HALF" }, start);

  state = applyMatchdayAction(state, { type: "ADJUST_CLOCK", deltaSeconds: 5 }, start);
  assert.equal(state.clockBaseSeconds, 5);
  assert.equal(state.clockRunning, false);

  state = applyMatchdayAction(state, { type: "START_CLOCK" }, start);
  const afterTenSeconds = new Date(Date.parse(start) + 10_000).toISOString();
  state = applyMatchdayAction(state, { type: "ADJUST_CLOCK", deltaSeconds: -5 }, afterTenSeconds);
  assert.equal(state.clockBaseSeconds, 10);
  assert.equal(state.clockRunning, true);
  assert.equal(currentClockSeconds(state, Date.parse(afterTenSeconds) + 1_000), 11);

  state = applyMatchdayAction(state, { type: "ADJUST_CLOCK", deltaSeconds: 3_000 }, afterTenSeconds);
  assert.equal(state.clockBaseSeconds, 2_700);
  assert.equal(state.clockRunning, false);

  const beforeMatch = createInitialState("A", "B", start);
  assert.equal(applyMatchdayAction(beforeMatch, { type: "ADJUST_CLOCK", deltaSeconds: 5 }, start), beforeMatch);
});

test("trocar lados e renomear equipas normalizam para o marcador", () => {
  let state = createInitialState("A", "B");
  state = applyMatchdayAction(state, { type: "SET_TEAMS", homeTeam: "  Home Team ", awayTeam: "away team" });
  assert.equal(state.homeTeam, "HOME TEAM");
  assert.equal(state.awayTeam, "AWAY TEAM");
  state = applyMatchdayAction(state, { type: "SWITCH_SIDES" });
  assert.equal(state.homeTeam, "AWAY TEAM");
  assert.equal(state.awayTeam, "HOME TEAM");
});

test("reset repõe o marcador mantendo as equipas", () => {
  let state = createInitialState("A", "B");
  state = applyMatchdayAction(state, { type: "SCORE", side: "home", delta: 1 });
  state = applyMatchdayAction(state, { type: "SET_PERIOD", period: "SECOND_HALF" });
  const reset = applyMatchdayAction(state, { type: "RESET" });
  assert.equal(reset.homeScore, 0);
  assert.equal(reset.period, "PRE_MATCH");
  assert.equal(reset.clockRunning, false);
  assert.equal(reset.clockBaseSeconds, 0);
  assert.equal(reset.homeTeam, state.homeTeam);
  assert.equal(matchdayValuesChanged(state, reset), true);
});

test("formatMatchdayClock usa MM:SS com minutos acima de 60", () => {
  assert.equal(formatMatchdayClock(0), "00:00");
  assert.equal(formatMatchdayClock(4_052), "67:32");
  assert.equal(formatMatchdayClock(7_200), "120:00");
  assert.equal(formatMatchdayClock(-10), "00:00");
});

test("os limites dos períodos estão certos", () => {
  assert.equal(MATCHDAY_PERIOD_MAX_SECONDS.FIRST_HALF, 45 * 60);
  assert.equal(MATCHDAY_PERIOD_MAX_SECONDS.SECOND_HALF, 90 * 60);
  assert.equal(MATCHDAY_PERIOD_MAX_SECONDS.EXTRA_FIRST_HALF, 105 * 60);
  assert.equal(MATCHDAY_PERIOD_MAX_SECONDS.EXTRA_SECOND_HALF, 120 * 60);
  assert.equal(MATCHDAY_PERIOD_MAX_SECONDS.FULL_TIME, 90 * 60);
  assert.equal(MATCHDAY_PERIOD_MAX_SECONDS.EXTRA_FULL_TIME, 120 * 60);
});

test("ações sem efeito devolvem o mesmo objeto", () => {
  let state = createInitialState("A", "B");
  assert.equal(applyMatchdayAction(state, { type: "PAUSE_CLOCK" }), state);
  assert.equal(applyMatchdayAction(state, { type: "SCORE", side: "home", delta: -1 }), state);
  assert.equal(applyMatchdayAction(state, { type: "SET_PERIOD", period: "PRE_MATCH" }), state);
  state = applyMatchdayAction(state, { type: "SET_PERIOD", period: "FIRST_HALF" });
  assert.equal(applyMatchdayAction(state, { type: "SET_PERIOD", period: "FIRST_HALF" }), state);
  state = applyMatchdayAction(state, { type: "START_CLOCK" });
  assert.equal(applyMatchdayAction(state, { type: "START_CLOCK" }), state);
});
