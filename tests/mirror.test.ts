import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyMatchdayAction,
  createInitialState,
  type MatchdayState,
} from "../src/domain/matchday";
import type { MatchdayCommandAction } from "../src/commands";
import { TeleScoreMirror, type TeleScoreMirrorOptions } from "../src/mirror";

const FILES = {
  homeName: "Home Name.txt",
  homeScore: "Home Score.txt",
  awayName: "Away Name.txt",
  awayScore: "Away Score.txt",
  clock: "Clock.txt",
};

interface Harness {
  dir: string;
  actions: MatchdayCommandAction[];
  own: Map<string, string>;
  mirror: TeleScoreMirror;
  setState: (state: MatchdayState | null) => void;
  cleanup: () => void;
}

function makeHarness(overrides: Partial<TeleScoreMirrorOptions> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "mc-mirror-"));
  const actions: MatchdayCommandAction[] = [];
  const own = new Map<string, string>();
  let state: MatchdayState | null = createInitialState("A", "B", "2026-08-20T00:00:00.000Z");
  const mirror = new TeleScoreMirror({
    watchDir: dir,
    files: FILES,
    pollMs: 500,
    adoptTeams: true,
    adoptScores: true,
    adoptClock: true,
    processName: null,
    getState: () => state,
    ownValue: (key) => own.get(key),
    applyActions: (list) => actions.push(...list),
    ...overrides,
  });
  return {
    dir,
    actions,
    own,
    mirror,
    setState: (next) => {
      state = next;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function write(h: Harness, name: string, content: string): void {
  writeFileSync(join(h.dir, name), content, "utf8");
}

test("adota equipas e resultado de ficheiros mais recentes que o estado", () => {
  const h = makeHarness();
  try {
    write(h, "Home Name.txt", "ACADÉMICA");
    write(h, "Away Name.txt", "CD FEIRENSE");
    write(h, "Home Score.txt", "2");
    write(h, "Away Score.txt", "0");
    h.mirror.reconcileOnce();
    assert.equal(
      h.actions.some(
        (a) => a.type === "SET_TEAMS" && a.homeTeam === "ACADÉMICA" && a.awayTeam === "CD FEIRENSE",
      ),
      true,
    );
    assert.equal(h.actions.some((a) => a.type === "SET_SCORE" && a.side === "home" && a.score === 2), true);
    // Away Score "0" é igual ao estado atual → sem ação.
    assert.equal(h.actions.some((a) => a.type === "SET_SCORE" && a.side === "away"), false);
  } finally {
    h.cleanup();
  }
});

test("duas equipas mudadas na mesma passada geram um único SET_TEAMS", () => {
  const h = makeHarness();
  try {
    write(h, "Home Name.txt", "ACADÉMICA");
    write(h, "Away Name.txt", "CD MAFRA");
    h.mirror.reconcileOnce();
    const teams = h.actions.filter((a) => a.type === "SET_TEAMS");
    assert.equal(teams.length, 1);
    assert.deepEqual(teams[0], { type: "SET_TEAMS", homeTeam: "ACADÉMICA", awayTeam: "CD MAFRA" });
  } finally {
    h.cleanup();
  }
});

test("ignora escritas próprias (estado, ficheiro e último valor coincidem)", () => {
  const h = makeHarness();
  try {
    write(h, "Home Name.txt", "B");
    h.own.set("homeName", "B");
    h.setState({ ...createInitialState("A", "B"), homeTeam: "B" });
    h.mirror.reconcileOnce();
    assert.deepEqual(h.actions, []);
  } finally {
    h.cleanup();
  }
});

test("ficheiro mais antigo que o estado não é adotado", () => {
  const h = makeHarness();
  try {
    write(h, "Home Score.txt", "5");
    h.setState({ ...createInitialState("A", "B"), homeScore: 0, updatedAt: new Date(Date.now() + 60_000).toISOString() });
    h.mirror.reconcileOnce();
    assert.deepEqual(h.actions, []);
  } finally {
    h.cleanup();
  }
});

test("relógio externo adotado com relógio parado e limitado ao período", () => {
  const h = makeHarness();
  try {
    const old = "2026-08-20T00:00:00.000Z";
    h.setState(
      applyMatchdayAction(createInitialState("A", "B", old), { type: "SET_PERIOD", period: "FIRST_HALF" }, old),
    );
    write(h, "Clock.txt", "46:00");
    h.mirror.reconcileOnce();
    assert.deepEqual(h.actions, [{ type: "SET_CLOCK", seconds: 45 * 60 }]);

    h.actions.length = 0;
    h.own.set("clock", "45:00");
    write(h, "Clock.txt", "45:00");
    h.mirror.reconcileOnce();
    assert.deepEqual(h.actions, []);
  } finally {
    h.cleanup();
  }
});

test("relógio externo ignorado com relógio a correr e conflito reportado", () => {
  const h = makeHarness();
  try {
    const old = "2026-08-20T00:00:00.000Z";
    const started = applyMatchdayAction(
      applyMatchdayAction(createInitialState("A", "B", old), { type: "SET_PERIOD", period: "FIRST_HALF" }, old),
      { type: "START_CLOCK" },
      old,
    );
    h.setState(started);
    write(h, "Clock.txt", "01:00");
    h.mirror.reconcileOnce();
    assert.equal(h.actions.some((a) => a.type === "SET_CLOCK"), false);
    assert.equal(h.mirror.getStatus().clockConflict, true);
    assert.ok(h.mirror.getStatus().lastSeenAt);
  } finally {
    h.cleanup();
  }
});

test("conflito desaparece quando o nosso relógio para", () => {
  const h = makeHarness();
  try {
    const old = "2026-08-20T00:00:00.000Z";
    const started = applyMatchdayAction(
      applyMatchdayAction(createInitialState("A", "B", old), { type: "SET_PERIOD", period: "FIRST_HALF" }, old),
      { type: "START_CLOCK" },
      old,
    );
    h.setState(started);
    write(h, "Clock.txt", "01:00");
    h.mirror.reconcileOnce();
    assert.equal(h.mirror.getStatus().clockConflict, true);
    h.setState({ ...started, clockRunning: false, clockBaseSeconds: 60, clockStartedAt: null });
    assert.equal(h.mirror.getStatus().clockConflict, false);
  } finally {
    h.cleanup();
  }
});

test("ficheiros inválidos ou inexistentes não são adotados", () => {
  const h = makeHarness();
  try {
    write(h, "Home Score.txt", "abc");
    write(h, "Home Name.txt", "   ");
    h.mirror.reconcileOnce();
    assert.deepEqual(h.actions, []);
    h.mirror.reconcileOnce();
    assert.deepEqual(h.actions, []);
  } finally {
    h.cleanup();
  }
});

test("online por atividade quando não há processo configurado", () => {
  const h = makeHarness();
  try {
    assert.equal(h.mirror.getStatus().online, false);
    write(h, "Home Score.txt", "1");
    h.mirror.reconcileOnce();
    assert.equal(h.mirror.getStatus().online, true);
  } finally {
    h.cleanup();
  }
});

test("online falso quando o processo não existe", () => {
  const h = makeHarness({ processName: "ProcessoQueNaoExiste123.exe" });
  try {
    write(h, "Home Score.txt", "1");
    h.mirror.reconcileOnce();
    assert.equal(h.mirror.getStatus().online, false);
  } finally {
    h.cleanup();
  }
});
