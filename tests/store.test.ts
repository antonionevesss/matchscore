import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Database } from "bun:sqlite";
import { ConflictError, MatchdayStore } from "../src/store";
import { createInitialState } from "../src/domain/matchday";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "mc-store-"));
}

test("commit + load fazem roundtrip com histórico", () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, "matchday.db");
    const { store } = MatchdayStore.open(dbPath);
    const state = { ...createInitialState("A", "B"), homeScore: 3, version: 1 };
    store.commit(state, []);
    const second = { ...state, homeScore: 4, version: 2 };
    store.commit(second, [state]);
    store.close();

    const reopened = MatchdayStore.open(dbPath).store;
    const session = reopened.load();
    assert.equal(session.state?.homeScore, 4);
    assert.equal(session.state?.version, 2);
    assert.equal(session.history.length, 1);
    assert.equal(session.history[0].homeScore, 3);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remove temporário de backup antigo antes de criar a cópia", () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, "matchday.db");
    const { store } = MatchdayStore.open(dbPath);
    const first = createInitialState("A", "B");
    store.commit(first, []);
    const staleTemp = `${dbPath}.bak.${process.pid}.tmp`;
    writeFileSync(staleTemp, "temporário antigo", "utf8");
    store.commit({ ...first, homeScore: 1, version: 2 }, [first]);
    assert.equal(existsSync(staleTemp), false);
    assert.equal(existsSync(`${dbPath}.bak`), true);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commit com versão desatualizada lança ConflictError", () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, "matchday.db");
    const { store } = MatchdayStore.open(dbPath);
    const state = createInitialState("A", "B");
    store.commit(state, []);
    assert.throws(() => store.commit({ ...state, version: 3 }, []), ConflictError);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DB corrompido é restaurado a partir do backup", () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, "matchday.db");
    const { store } = MatchdayStore.open(dbPath);
    const state = { ...createInitialState("A", "B"), homeScore: 2, version: 1 };
    store.commit(state, []);
    store.close();
    assert.equal(existsSync(join(dir, "matchday.db.bak")), true);

    writeFileSync(dbPath, "isto não é uma base de dados sqlite", "utf8");
    const result = MatchdayStore.open(dbPath);
    assert.equal(result.restoredFromBackup, true);
    assert.ok(result.startupError);
    const session = result.store.load();
    assert.equal(session.state?.homeScore, 2);
    result.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("estado persistido inválido também cai no backup", () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, "matchday.db");
    const { store } = MatchdayStore.open(dbPath);
    const state = { ...createInitialState("A", "B"), homeScore: 5, version: 1 };
    store.commit(state, []);
    store.close();

    const { store: opener } = MatchdayStore.open(dbPath);
    opener.close();
    // Corrompe apenas o state_json diretamente na tabela.
    const db = new Database(dbPath);
    db.query("UPDATE state SET state_json = ? WHERE id = 1").run('{"not":"valid"}');
    db.close();

    const result = MatchdayStore.open(dbPath);
    assert.equal(result.restoredFromBackup, true);
    assert.equal(result.store.load().state?.homeScore, 5);
    result.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sem estado gravado devolve null", () => {
  const dir = tempDir();
  try {
    const { store } = MatchdayStore.open(join(dir, "matchday.db"));
    assert.deepEqual(store.load(), { state: null, history: [] });
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
