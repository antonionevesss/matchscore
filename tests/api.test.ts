import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MatchdayServer } from "../src/api";
import { hashAccessPassword, randomTokenSecret } from "../src/auth";
import type { ObsConfig } from "../src/config";
import type { ObsLaunchResult } from "../src/obs-launcher";
import { MatchdayStore } from "../src/store";
import { TxtWriter } from "../src/writer";

const SECRET = randomTokenSecret();
const PIN = "246810";
const ACCESS_PIN_HASH = hashAccessPassword(PIN);

interface TestHarness {
  dir: string;
  dbPath: string;
  outputDir: string;
  app: MatchdayServer;
  baseUrl: string;
  localCheck: (request: Request) => boolean;
  store: MatchdayStore;
  writer: TxtWriter;
  stop: () => Promise<void>;
}

async function startApp(options: {
  local?: boolean;
  obs?: ObsConfig;
  launchObsProcess?: (configuredPath?: string) => ObsLaunchResult;
  focusObsProcess?: () => boolean;
} = {}): Promise<TestHarness> {
  const dir = mkdtempSync(join(tmpdir(), "mc-api-"));
  const dbPath = join(dir, "matchday.db");
  const outputDir = join(dir, "obs");
  const config = {
    configPath: join(dir, "config.json"),
    exeDir: dir,
    outputDir,
    files: {
      homeName: "Home Name.txt",
      homeScore: "Home Score.txt",
      awayName: "Away Name.txt",
      awayScore: "Away Score.txt",
      clock: "Clock.txt",
    },
    openBrowserOnStart: false,
    port: 0,
    bind: "127.0.0.1",
    obs: options.obs,
    accessPinHash: ACCESS_PIN_HASH,
    tokenSecret: SECRET,
    tokenTtlMs: 60_000,
  } as const;
  const { store } = MatchdayStore.open(dbPath);
  const writer = new TxtWriter(outputDir);
  const localCheck = () => options.local ?? false;
  const app = new MatchdayServer({ config, store, writer, localCheck, launchObsProcess: options.launchObsProcess, focusObsProcess: options.focusObsProcess });
  const server = app.start(0);
  const baseUrl = `http://127.0.0.1:${server.port}`;
  return {
    dir,
    dbPath,
    outputDir,
    app,
    baseUrl,
    localCheck,
    store,
    writer,
    stop: async () => {
      await app.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function login(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin: PIN }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { token: string };
  return body.token;
}

test("health responde sem autenticação", async () => {
  const harness = await startApp();
  try {
    const response = await fetch(`${harness.baseUrl}/api/health`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.status, "ok");
    assert.equal(body.stateVersion, null);
    assert.equal(body.filesOk, true);
    assert.ok(Number.isFinite(body.serverNowMs));
  } finally {
    await harness.stop();
  }
});

test("logs protegidos mostram eventos com hora, tipo e nível", async () => {
  const harness = await startApp({ local: true });
  try {
    assert.equal((await fetch(`${harness.baseUrl}/api/logs`)).status, 401);
    const token = await login(harness.baseUrl);
    const initial = await fetch(`${harness.baseUrl}/api/logs?limit=10`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(initial.status, 200);
    const initialBody = await initial.json() as {
      logs: Array<{ at: string; category: string; level: string; message: string }>;
    };
    assert.ok(initialBody.logs.length > 0);
    assert.ok(initialBody.logs.every((entry) => entry.at && entry.category && entry.level && entry.message));
    assert.ok(initialBody.logs.every((entry) => Number.isFinite(Date.parse(entry.at))));
    assert.ok(initialBody.logs.some((entry) => entry.category === "system"));

    await fetch(`${harness.baseUrl}/api/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ homeTeam: "HOME", awayTeam: "AWAY" }),
    });
    const afterSetup = await fetch(`${harness.baseUrl}/api/logs?limit=200`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const afterSetupBody = await afterSetup.json() as { logs: Array<{ category: string; message: string }> };
    assert.ok(afterSetupBody.logs.some((entry) => entry.category === "match" && entry.message.includes("HOME")));
  } finally {
    await harness.stop();
  }
});

test("logs aceitam filtros e exportação autenticada", async () => {
  const harness = await startApp({ local: true });
  try {
    const token = await login(harness.baseUrl);
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
    await fetch(`${harness.baseUrl}/api/setup`, {
      method: "POST",
      headers,
      body: JSON.stringify({ homeTeam: "CASA", awayTeam: "FORA" }),
    });

    const filtered = await fetch(`${harness.baseUrl}/api/logs?category=match&q=CASA`, { headers });
    assert.equal(filtered.status, 200);
    const filteredBody = await filtered.json() as { total: number; logs: Array<{ category: string; message: string }> };
    assert.equal(filteredBody.total, 1);
    assert.equal(filteredBody.logs[0]?.category, "match");
    assert.match(filteredBody.logs[0]?.message ?? "", /CASA/);

    const exportResponse = await fetch(`${harness.baseUrl}/api/logs/export?category=match`, { headers });
    assert.equal(exportResponse.status, 200);
    assert.match(exportResponse.headers.get("content-type") ?? "", /text\/plain/);
    assert.match(await exportResponse.text(), /CASA/);

    assert.equal((await fetch(`${harness.baseUrl}/api/logs?level=invalid`, { headers })).status, 400);
  } finally {
    await harness.stop();
  }
});

test("health expõe OBS e a cena falha de forma isolada quando está desativado", async () => {
  const harness = await startApp();
  try {
    const health = await (await fetch(`${harness.baseUrl}/api/health`)).json() as {
      obs: {
        enabled: boolean;
        connected: boolean;
        previewProjector: { monitorIndex: number };
        previewProjectorOpen: boolean | null;
      };
    };
    assert.equal(health.obs.enabled, false);
    assert.equal(health.obs.connected, false);
    assert.equal(health.obs.previewProjector.monitorIndex, 1);
    assert.equal(health.obs.previewProjectorOpen, null);

    const token = await login(harness.baseUrl);
    const response = await fetch(`${harness.baseUrl}/api/obs/scene`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ sceneKey: "goal" }),
    });
    assert.equal(response.status, 503);
    const preview = await fetch(`${harness.baseUrl}/api/obs/preview-projector`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    });
    assert.equal(preview.status, 503);
  } finally {
    await harness.stop();
  }
});

test("configuração OBS pode ser alterada e testada pela webapp", async () => {
  const harness = await startApp();
  try {
    const token = await login(harness.baseUrl);
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
    const initial = await fetch(`${harness.baseUrl}/api/obs/settings`, { headers });
    assert.equal(initial.status, 200);
    const initialBody = await initial.json() as { settings: { passwordSet: boolean; port: number } };
    assert.equal(initialBody.settings.passwordSet, false);
    assert.equal(initialBody.settings.port, 4455);

    const saved = await fetch(`${harness.baseUrl}/api/obs/settings`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        enabled: false,
        host: "192.168.1.20",
        port: 4456,
        password: "secret",
        scenes: {
          matchscore: "MATCH",
          goal: "GOAL",
          sponsors: "SPONSORS",
          music: "MUSIC",
          lineup: "LINEUP",
        },
        sceneLabels: { music: "Initial music", lineup: "Starting line-up" },
        previewProjector: { enabled: true, monitorIndex: 1, autoOpen: true },
      }),
    });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json() as {
      settings: {
        host: string;
        port: number;
        passwordSet: boolean;
        scenes: Record<string, string>;
        sceneLabels: Record<string, string>;
        previewProjector: { enabled: boolean; monitorIndex: number; autoOpen: boolean };
      };
      obs: { enabled: boolean };
    };
    assert.equal(savedBody.settings.host, "192.168.1.20");
    assert.equal(savedBody.settings.port, 4456);
    assert.equal(savedBody.settings.passwordSet, true);
    assert.equal(savedBody.settings.scenes.music, "MUSIC");
    assert.equal(savedBody.settings.scenes.lineup, "LINEUP");
    assert.equal(savedBody.settings.sceneLabels.lineup, "Starting line-up");
    assert.deepEqual(savedBody.settings.previewProjector, { enabled: true, monitorIndex: 1, autoOpen: true });
    assert.equal(savedBody.obs.enabled, false);

    const persisted = JSON.parse(readFileSync(join(harness.dir, "config.json"), "utf8")) as {
      obs: { host: string; port: number; password: string };
    };
    assert.equal(persisted.obs.host, "192.168.1.20");
    assert.equal(persisted.obs.port, 4456);
    assert.equal(persisted.obs.password, "secret");

    const testConnection = await fetch(`${harness.baseUrl}/api/obs/test`, { method: "POST", headers });
    assert.equal(testConnection.status, 503);
  } finally {
    await harness.stop();
  }
});

test("abrir OBS é uma rota autenticada e não duplica a lógica do launcher", async () => {
  let requestedPath: string | undefined;
  const harness = await startApp({
    obs: {
      enabled: true,
      host: "127.0.0.1",
      port: 4455,
      password: "",
      executablePath: "C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe",
      scenes: { matchscore: "Match score" },
      sceneLabels: {},
      previewProjector: { enabled: true, monitorIndex: 1, autoOpen: false },
    },
    launchObsProcess: (configuredPath) => {
      requestedPath = configuredPath;
      return { alreadyRunning: false, executablePath: configuredPath || "obs64.exe" };
    },
  });
  try {
    assert.equal((await fetch(`${harness.baseUrl}/api/obs/launch`, { method: "POST" })).status, 401);
    const token = await login(harness.baseUrl);
    const response = await fetch(`${harness.baseUrl}/api/obs/launch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { alreadyRunning: boolean; executablePath: string };
    assert.equal(body.alreadyRunning, false);
    assert.equal(body.executablePath, "C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe");
    assert.equal(requestedPath, body.executablePath);
  } finally {
    await harness.stop();
  }
});

test("recuperar ligação OBS exige autenticação e devolve o estado atual", async () => {
  const harness = await startApp();
  try {
    assert.equal((await fetch(`${harness.baseUrl}/api/obs/retry`, { method: "POST" })).status, 401);
    const token = await login(harness.baseUrl);
    const response = await fetch(`${harness.baseUrl}/api/obs/retry`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 503);
    const body = await response.json() as { obs: { enabled: boolean } };
    assert.equal(body.obs.enabled, false);
  } finally {
    await harness.stop();
  }
});

test("focar a janela OBS é autenticado e reporta quando a janela existe", async () => {
  let focused = false;
  const harness = await startApp({ focusObsProcess: () => { focused = true; return true; } });
  try {
    const token = await login(harness.baseUrl);
    const response = await fetch(`${harness.baseUrl}/api/obs/focus`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.equal(focused, true);
    const body = await response.json() as { focused: boolean };
    assert.equal(body.focused, true);
  } finally {
    await harness.stop();
  }
});

test("auth: PIN errado 401, correto dá token; rotas privadas exigem token", async () => {
  const harness = await startApp();
  try {
    const bad = await fetch(`${harness.baseUrl}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: "000000" }),
    });
    assert.equal(bad.status, 401);

    const unauthorized = await fetch(`${harness.baseUrl}/api/state`);
    assert.equal(unauthorized.status, 401);

    const token = await login(harness.baseUrl);
    assert.ok(token.length > 20);
    const state = await fetch(`${harness.baseUrl}/api/state`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(state.status, 200);
    const body = (await state.json()) as { state: unknown; setupAllowed: boolean; clockSeconds: number };
    assert.equal(body.state, null);
    assert.equal(body.setupAllowed, false);
    assert.equal(body.clockSeconds, 0);
  } finally {
    await harness.stop();
  }
});

test("rate limit reinicia depois da janela de tentativas", async () => {
  const harness = await startApp();
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fetch(`${harness.baseUrl}/api/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: "errada" }),
      });
      assert.equal(response.status, 401);
    }
    const locked = await fetch(`${harness.baseUrl}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: "errada" }),
    });
    assert.equal(locked.status, 429);

    now += 60_001;
    assert.equal(await (await fetch(`${harness.baseUrl}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: PIN }),
    })).status, 200);
  } finally {
    Date.now = originalNow;
    await harness.stop();
  }
});

test("setup é bloqueado fora do PC local e funciona localmente", async () => {
  const remote = await startApp({ local: false });
  try {
    const token = await login(remote.baseUrl);
    const blocked = await fetch(`${remote.baseUrl}/api/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ homeTeam: "HOME TEAM", awayTeam: "AWAY TEAM" }),
    });
    assert.equal(blocked.status, 403);
  } finally {
    await remote.stop();
  }

  const local = await startApp({ local: true });
  try {
    const token = await login(local.baseUrl);
    const response = await fetch(`${local.baseUrl}/api/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ homeTeam: "  Home Team ", awayTeam: "away team" }),
    });
    assert.equal(response.status, 200);
    const snapshot = (await response.json()) as { state: { homeTeam: string; awayTeam: string; version: number } };
    assert.equal(snapshot.state.homeTeam, "HOME TEAM");
    assert.equal(snapshot.state.awayTeam, "AWAY TEAM");
    assert.equal(snapshot.state.version, 1);

    assert.equal(readFileSync(join(local.outputDir, "Home Name.txt"), "utf8"), "HOME TEAM");
    assert.equal(readFileSync(join(local.outputDir, "Away Name.txt"), "utf8"), "AWAY TEAM");
    assert.equal(readFileSync(join(local.outputDir, "Home Score.txt"), "utf8"), "0");
  } finally {
    await local.stop();
  }
});

test("comandos atualizam estado, ficheiros e versão; 409 em versão desatualizada", async () => {
  const harness = await startApp({ local: true });
  try {
    const token = await login(harness.baseUrl);
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
    await fetch(`${harness.baseUrl}/api/setup`, {
      method: "POST",
      headers,
      body: JSON.stringify({ homeTeam: "A", awayTeam: "B" }),
    });

    const score = await fetch(`${harness.baseUrl}/api/command`, {
      method: "POST",
      headers,
      body: JSON.stringify({ baseVersion: 1, action: { type: "SCORE", side: "home", delta: 1 } }),
    });
    assert.equal(score.status, 200);
    const scored = (await score.json()) as { state: { homeScore: number; version: number } };
    assert.equal(scored.state.homeScore, 1);
    assert.equal(scored.state.version, 2);
    assert.equal(readFileSync(join(harness.outputDir, "Home Score.txt"), "utf8"), "1");

    const stale = await fetch(`${harness.baseUrl}/api/command`, {
      method: "POST",
      headers,
      body: JSON.stringify({ baseVersion: 1, action: { type: "SCORE", side: "away", delta: 1 } }),
    });
    assert.equal(stale.status, 409);
    const conflict = (await stale.json()) as { snapshot: { state: { homeScore: number; version: number } } };
    assert.equal(conflict.snapshot.state.homeScore, 1);
    assert.equal(conflict.snapshot.state.version, 2);

    const undo = await fetch(`${harness.baseUrl}/api/command`, {
      method: "POST",
      headers,
      body: JSON.stringify({ baseVersion: 2, action: { type: "UNDO" } }),
    });
    assert.equal(undo.status, 200);
    const undone = (await undo.json()) as { state: { homeScore: number; version: number } };
    assert.equal(undone.state.homeScore, 0);
    assert.equal(undone.state.version, 3);
  } finally {
    await harness.stop();
  }
});

test("relógio em contagem sobrevive a reinício (derivado de timestamps)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-restart-"));
  try {
    const dbPath = join(dir, "matchday.db");
    const outputDir = join(dir, "obs");
    const config = {
      configPath: join(dir, "config.json"),
      exeDir: dir,
      outputDir,
      files: {
        homeName: "Home Name.txt",
        homeScore: "Home Score.txt",
        awayName: "Away Name.txt",
        awayScore: "Away Score.txt",
        clock: "Clock.txt",
      },
      openBrowserOnStart: false,
      port: 0,
      bind: "127.0.0.1",
      accessPinHash: ACCESS_PIN_HASH,
      tokenSecret: SECRET,
      tokenTtlMs: 60_000,
    } as const;

    const first = MatchdayStore.open(dbPath).store;
    const writer = new TxtWriter(outputDir);
    const app = new MatchdayServer({ config, store: first, writer, localCheck: () => true });
    const server = app.start(0);
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const token = await login(baseUrl);
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
    await fetch(`${baseUrl}/api/setup`, {
      method: "POST",
      headers,
      body: JSON.stringify({ homeTeam: "A", awayTeam: "B" }),
    });
    await fetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers,
      body: JSON.stringify({ baseVersion: 1, action: { type: "SET_PERIOD", period: "FIRST_HALF" } }),
    });
    await fetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers,
      body: JSON.stringify({ baseVersion: 2, action: { type: "START_CLOCK" } }),
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500));
    await app.stop();
    first.close();

    const second = MatchdayStore.open(dbPath).store;
    const session = second.load();
    assert.equal(session.state?.clockRunning, true);
    assert.ok(session.state?.clockStartedAt);
    const startedAt = Date.parse(session.state.clockStartedAt!);
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    assert.ok(elapsed >= 1);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot e Clock.txt usam o mesmo segundo autoritativo do servidor", async () => {
  const harness = await startApp({ local: true });
  try {
    const token = await login(harness.baseUrl);
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
    await fetch(`${harness.baseUrl}/api/setup`, {
      method: "POST",
      headers,
      body: JSON.stringify({ homeTeam: "A", awayTeam: "B" }),
    });
    const period = await fetch(`${harness.baseUrl}/api/command`, {
      method: "POST",
      headers,
      body: JSON.stringify({ baseVersion: 1, action: { type: "SET_PERIOD", period: "SECOND_HALF" } }),
    });
    const periodBody = await period.json() as { state: { clockStartedAt: string } };
    const startedAt = Date.parse(periodBody.state.clockStartedAt);
    const expectedNow = startedAt + 1_250;
    harness.app.tickClock(expectedNow);
    assert.equal(readFileSync(join(harness.outputDir, "Clock.txt"), "utf8"), "45:01");
    const snapshot = harness.app.snapshot(expectedNow);
    assert.equal(snapshot.clockSeconds, 45 * 60 + 1);
    assert.equal(snapshot.serverNowMs, expectedNow);
  } finally {
    await harness.stop();
  }
});

test("tick do relógio mantém uma sequência contínua no Clock.txt", async () => {
  const harness = await startApp({ local: true });
  try {
    const token = await login(harness.baseUrl);
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
    await fetch(`${harness.baseUrl}/api/setup`, {
      method: "POST",
      headers,
      body: JSON.stringify({ homeTeam: "A", awayTeam: "B" }),
    });
    const period = await fetch(`${harness.baseUrl}/api/command`, {
      method: "POST",
      headers,
      body: JSON.stringify({ baseVersion: 1, action: { type: "SET_PERIOD", period: "SECOND_HALF" } }),
    });
    const periodBody = await period.json() as { state: { clockStartedAt: string } };
    const startedAt = Date.parse(periodBody.state.clockStartedAt);

    for (const offsetMs of [0, 250, 999, 1_000, 1_250, 1_999, 2_000]) {
      const nowMs = startedAt + offsetMs;
      harness.app.tickClock(nowMs);
      const expected = `45:${String(Math.floor(offsetMs / 1_000)).padStart(2, "0")}`;
      assert.equal(readFileSync(join(harness.outputDir, "Clock.txt"), "utf8"), expected);
      assert.equal(harness.app.snapshot(nowMs).clockSeconds, 45 * 60 + Math.floor(offsetMs / 1_000));
    }
  } finally {
    await harness.stop();
  }
});

test("SSE emite evento de estado no arranque da stream", async () => {
  const harness = await startApp({ local: true });
  try {
    const token = await login(harness.baseUrl);
    const response = await fetch(`${harness.baseUrl}/api/stream?token=${encodeURIComponent(token)}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const { value } = await reader.read();
    const chunk = decoder.decode(value);
    assert.match(chunk, /event: state/);
    await reader.cancel();
  } finally {
    await harness.stop();
  }
});

test("SSE remove o subscriber quando o cliente cancela a stream", async () => {
  const harness = await startApp({ local: true });
  try {
    const token = await login(harness.baseUrl);
    const response = await fetch(`${harness.baseUrl}/api/stream?token=${encodeURIComponent(token)}`);
    const reader = response.body!.getReader();
    await reader.read();
    const internals = harness.app as unknown as { subscribers: Set<unknown> };
    assert.equal(internals.subscribers.size, 1);
    await reader.cancel();
    await Bun.sleep(0);
    assert.equal(internals.subscribers.size, 0);
  } finally {
    await harness.stop();
  }
});
