import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInitialState } from "../src/domain/matchday";
import { TxtWriter } from "../src/writer";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "mc-writer-"));
}

test("escreve os 5 ficheiros do marcador", () => {
  const dir = tempDir();
  try {
    const writer = new TxtWriter(dir);
    const state = createInitialState("HOME TEAM", "AWAY TEAM");
    writer.writeState({ ...state, homeScore: 2, awayScore: 1 }, Date.now(), true);
    assert.equal(readFileSync(join(dir, "Home Name.txt"), "utf8"), "HOME TEAM");
    assert.equal(readFileSync(join(dir, "Home Score.txt"), "utf8"), "2");
    assert.equal(readFileSync(join(dir, "Away Name.txt"), "utf8"), "AWAY TEAM");
    assert.equal(readFileSync(join(dir, "Away Score.txt"), "utf8"), "1");
    assert.equal(readFileSync(join(dir, "Clock.txt"), "utf8"), "00:00");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("só escreve quando o valor muda (não recria ficheiros apagados)", () => {
  const dir = tempDir();
  try {
    const writer = new TxtWriter(dir);
    const state = createInitialState("A", "B");
    writer.writeState(state, Date.now(), true);
    rmSync(join(dir, "Home Name.txt"));
    writer.writeState(state, Date.now(), false);
    assert.throws(() => readFileSync(join(dir, "Home Name.txt"), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("force reescreve tudo", () => {
  const dir = tempDir();
  try {
    const writer = new TxtWriter(dir);
    const state = createInitialState("A", "B");
    writer.writeState(state, Date.now(), true);
    rmSync(join(dir, "Home Name.txt"));
    writer.writeState(state, Date.now(), true);
    assert.equal(readFileSync(join(dir, "Home Name.txt"), "utf8"), "A");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("o relógio derivado é escrito em MM:SS", () => {
  const dir = tempDir();
  try {
    const writer = new TxtWriter(dir);
    // 2.ª parte em contagem: 45:00 base + 22:32 decorrido = 67:32.
    const started = new Date(Date.now() - 1_352_000).toISOString();
    const state = {
      ...createInitialState("A", "B"),
      period: "SECOND_HALF" as const,
      clockBaseSeconds: 45 * 60,
      clockRunning: true,
      clockStartedAt: started,
    };
    writer.writeState(state, Date.now(), true);
    assert.equal(readFileSync(join(dir, "Clock.txt"), "utf8"), "67:32");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("falha de escrita não lança; expõe lastError", () => {
  const dir = tempDir();
  try {
    // A pasta de saída é na verdade um ficheiro: as escritas falham.
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "x");
    const writer = new TxtWriter(blocked);
    const state = createInitialState("A", "B");
    const ok = writer.writeState(state, Date.now(), true);
    assert.equal(ok, false);
    assert.ok(writer.lastError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uma falha parcial permanece visível até a escrita falhada ser recuperada", () => {
  const dir = tempDir();
  try {
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "x");
    const writer = new TxtWriter(dir, {
      homeName: "Home Name.txt",
      homeScore: "blocked\\Home Score.txt",
      awayName: "Away Name.txt",
      awayScore: "Away Score.txt",
      clock: "Clock.txt",
    });
    const state = createInitialState("A", "B");
    assert.equal(writer.writeState(state, Date.now(), true), false);
    assert.ok(writer.lastError);

    rmSync(blocked, { force: true });
    mkdirSync(blocked);
    assert.equal(writer.writeState(state, Date.now(), false), true);
    assert.equal(writer.lastError, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe cria e remove o ficheiro de teste", () => {
  const dir = tempDir();
  try {
    const writer = new TxtWriter(dir);
    writer.probe();
    assert.throws(() => readFileSync(join(dir, ".matchday-write-test"), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
