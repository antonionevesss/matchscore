import assert from "node:assert/strict";
import test from "node:test";
import { applyCommand, isMatchdayCommandAction } from "../src/commands";
import { createInitialState } from "../src/domain/matchday";

test("ações sem efeito não avançam versão nem histórico", () => {
  const state = createInitialState("A", "B");
  const result = applyCommand(state, [], { type: "PAUSE_CLOCK" });
  assert.equal(result.applied, false);
  assert.equal(result.state, state);
  assert.deepEqual(result.history, []);
});

test("ação aplicada avança a versão e empurra o estado anterior", () => {
  const state = createInitialState("A", "B");
  const result = applyCommand(state, [], { type: "SCORE", side: "home", delta: 1 });
  assert.equal(result.applied, true);
  assert.equal(result.state.version, 2);
  assert.equal(result.state.homeScore, 1);
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0].version, 1);
});

test("undo repõe o último estado com versão nova e remove do histórico", () => {
  let state = createInitialState("A", "B");
  let history: typeof state[] = [];
  ({ state, history } = applyCommand(state, history, { type: "SCORE", side: "home", delta: 1 }));
  ({ state, history } = applyCommand(state, history, { type: "SCORE", side: "away", delta: 1 }));
  assert.equal(state.homeScore, 1);
  assert.equal(state.awayScore, 1);
  assert.equal(state.version, 3);
  ({ state, history } = applyCommand(state, history, { type: "UNDO" }));
  assert.equal(state.homeScore, 1);
  assert.equal(state.awayScore, 0);
  assert.equal(state.version, 4);
  assert.equal(history.length, 1);
});

test("undo sem histórico é no-op", () => {
  const state = createInitialState("A", "B");
  const result = applyCommand(state, [], { type: "UNDO" });
  assert.equal(result.applied, false);
  assert.equal(result.state, state);
});

test("reset limpa o histórico (não é anulável)", () => {
  let state = createInitialState("A", "B");
  let history: typeof state[] = [];
  ({ state, history } = applyCommand(state, history, { type: "SCORE", side: "home", delta: 1 }));
  ({ state, history } = applyCommand(state, history, { type: "RESET" }));
  assert.equal(state.homeScore, 0);
  assert.equal(history.length, 0);
  const undo = applyCommand(state, history, { type: "UNDO" });
  assert.equal(undo.applied, false);
});

test("histórico é limitado aos últimos 30 estados", () => {
  let state = createInitialState("A", "B");
  let history: typeof state[] = [];
  for (let index = 0; index < 40; index += 1) {
    ({ state, history } = applyCommand(state, history, { type: "SCORE", side: "home", delta: 1 }));
  }
  assert.equal(history.length, 30);
  assert.equal(history[0].homeScore, 39);
  assert.equal(history[29].homeScore, 10);
});

test("validador de ações rejeita formas inválidas", () => {
  assert.equal(isMatchdayCommandAction({ type: "UNDO" }), true);
  assert.equal(isMatchdayCommandAction({ type: "SCORE", side: "home", delta: 1 }), true);
  assert.equal(isMatchdayCommandAction({ type: "SCORE", side: "home", delta: 2 }), false);
  assert.equal(isMatchdayCommandAction({ type: "SET_SCORE", side: "away", score: 2 }), true);
  assert.equal(isMatchdayCommandAction({ type: "SET_SCORE", side: "away", score: Number.NaN }), false);
  assert.equal(isMatchdayCommandAction({ type: "SET_PERIOD", period: "OVERTIME" }), false);
  assert.equal(isMatchdayCommandAction({ type: "SET_CLOCK", seconds: "12" }), false);
  assert.equal(isMatchdayCommandAction({ type: "ADJUST_CLOCK", deltaSeconds: 5 }), true);
  assert.equal(isMatchdayCommandAction({ type: "ADJUST_CLOCK", deltaSeconds: 1.5 }), false);
  assert.equal(isMatchdayCommandAction({ type: "ADJUST_CLOCK", deltaSeconds: 3_601 }), false);
  assert.equal(isMatchdayCommandAction({ type: "EXPLODE" }), false);
  assert.equal(isMatchdayCommandAction(null), false);
});
