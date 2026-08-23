import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { randomTokenSecret } from "../src/auth";

const ROOT = join(import.meta.dir, "..");
const EXE = join(ROOT, "dist", "MatchdayControl.exe");

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(baseUrl: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return true;
    } catch {
      // ainda a arrancar
    }
    await Bun.sleep(200);
  }
  return false;
}

async function login(baseUrl: string, pin: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin }),
  });
  assert.equal(response.status, 200, "login deve funcionar");
  const body = (await response.json()) as { token: string };
  return body.token;
}

test("exe compilado: primeiro arranque, controlo, kill -9, restauro, lock", { timeout: 60_000 }, async (t) => {
  if (!existsSync(EXE)) {
    t.skip("dist/MatchdayControl.exe não existe — corre bun run build primeiro.");
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "mc-smoke-"));
  const outputDir = join(dir, "obs");
  const configPath = join(dir, "config.json");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const pin = "1887";
  const secret = randomTokenSecret();

  writeFileSync(
    configPath,
    JSON.stringify({
      outputDir,
      files: {
        homeName: "Home Name.txt",
        homeScore: "Home Score.txt",
        awayName: "Away Name.txt",
        awayScore: "Away Score.txt",
        clock: "Clock.txt",
      },
      port,
      bind: "127.0.0.1",
      pinHash: "legacy-pin-hash-ignored",
      tokenSecret: secret,
      openBrowserOnStart: false,
      tokenTtlMs: 60_000,
    }),
  );

  let process = Bun.spawn([EXE, "--config", configPath], { stdout: "ignore", stderr: "ignore" });

  try {
    assert.equal(await waitForHealth(baseUrl), true, "exe deve responder em /api/health");

    const ui = await fetch(`${baseUrl}/`);
    assert.equal(ui.status, 200);
    const uiHtml = await ui.text();
    assert.match(uiHtml, /Matchday Control/);
    assert.match(uiHtml, /id="login-pin"/);
    assert.match(uiHtml, /api\/stream/);
    assert.match(uiHtml, /id="dlg-period"/);
    assert.match(uiHtml, /id="clock-confirm"/);
    assert.match(uiHtml, /@keyframes dialog-in/);
    assert.match(uiHtml, /id="toggle-overtime"/);
    assert.doesNotMatch(uiHtml, /id="undo"/);
    assert.doesNotMatch(uiHtml, /footerHtml|class="footer"/);

    const token = await login(baseUrl, pin);
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

    const setup = await fetch(`${baseUrl}/api/setup`, {
      method: "POST",
      headers,
      body: JSON.stringify({ homeTeam: "ACADÉMICA", awayTeam: "CD FEIRENSE" }),
    });
    assert.equal(setup.status, 200);

    const score = await fetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers,
      body: JSON.stringify({ baseVersion: 1, action: { type: "SCORE", side: "home", delta: 1 } }),
    });
    assert.equal(score.status, 200);

    const startClock = await fetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers,
      body: JSON.stringify({ baseVersion: 2, action: { type: "SET_PERIOD", period: "FIRST_HALF" } }),
    });
    assert.equal(startClock.status, 200);
    const started = (await startClock.json()) as { state: { clockRunning: boolean } };
    assert.equal(started.state.clockRunning, false);

    const runClock = await fetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers,
      body: JSON.stringify({ baseVersion: 3, action: { type: "START_CLOCK" } }),
    });
    assert.equal(runClock.status, 200);
    const running = (await runClock.json()) as { state: { clockRunning: boolean } };
    assert.equal(running.state.clockRunning, true);

    assert.equal(readFileSync(join(outputDir, "Home Name.txt"), "utf8"), "ACADÉMICA");
    assert.equal(readFileSync(join(outputDir, "Home Score.txt"), "utf8"), "1");
    await Bun.sleep(2_500);
    const clockBefore = readFileSync(join(outputDir, "Clock.txt"), "utf8").trim();
    assert.notEqual(clockBefore, "00:00", "o relógio deve estar a avançar");

    // kill -9: simula crash; o lock e o estado ficam no disco.
    process.kill();
    await process.exited;

    // O estado é restaurado e o relógio retoma (derivado de timestamps).
    process = Bun.spawn([EXE, "--config", configPath], { stdout: "ignore", stderr: "ignore" });
    assert.equal(await waitForHealth(baseUrl), true, "deve voltar a arrancar sozinho");
    const state = await (await fetch(`${baseUrl}/api/state`, { headers })).json() as {
      state: { homeScore: number; version: number; clockRunning: boolean; clockStartedAt: string };
    };
    assert.equal(state.state.homeScore, 1);
    assert.equal(state.state.version, 4);
    assert.equal(state.state.clockRunning, true);
    const startedAt = Date.parse(state.state.clockStartedAt);
    assert.ok(Date.now() - startedAt > 1_000, "clockStartedAt deve persistir");
    await Bun.sleep(2_500);
    const clockAfter = readFileSync(join(outputDir, "Clock.txt"), "utf8").trim();
    assert.notEqual(clockAfter, clockBefore, "o relógio deve continuar a avançar após reinício");

    // Lock de instância única: segundo processo recusa arrancar.
    const second = Bun.spawn([EXE, "--config", configPath], { stdout: "pipe", stderr: "pipe" });
    const secondExit = await second.exited;
    assert.notEqual(secondExit, 0, "segunda instância deve recusar arrancar");
  } finally {
    try {
      process.kill();
    } catch {
      // já terminou
    }
    await process.exited.catch(() => {});

    // A palavra-passe é fixa: valores alternativos são rejeitados.
    const setPin = Bun.spawn([EXE, "--config", configPath, "--set-pin", "987654"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    assert.notEqual(await setPin.exited, 0, "--set-pin deve rejeitar valores alternativos");
    const fixedPin = Bun.spawn([EXE, "--config", configPath, "--set-pin", "1887"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    assert.equal(await fixedPin.exited, 0, "--set-pin 1887 deve ser aceite");

    rmSync(dir, { recursive: true, force: true });
  }
});
