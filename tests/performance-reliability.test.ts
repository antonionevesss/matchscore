import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MatchdayServer } from "../src/api";
import { isLocalObsHost, ObsWebSocketClient } from "../src/obs";
import { detectObsProcessState } from "../src/obs-launcher";
import { isProcessAlive } from "../src/process";
import { MatchdayStore } from "../src/store";
import { TxtWriter } from "../src/writer";

describe("performance e reliability", () => {
  test("isProcessAlive identifica processos ativos e inativos com ultra-baixa latência", () => {
    const start = performance.now();
    const selfAlive = isProcessAlive(process.pid);
    const fakeAlive = isProcessAlive(9999999);
    const elapsed = performance.now() - start;

    expect(selfAlive).toBe(true);
    expect(fakeAlive).toBe(false);
    // Verificação Win32 FFI deve demorar < 15ms
    expect(elapsed).toBeLessThan(15);
  });

  test("detectObsProcessState corre instantaneamente em memória", () => {
    const start = performance.now();
    const state = detectObsProcessState();
    const elapsed = performance.now() - start;

    expect(["visible", "notDetected", "unknown"]).toContain(state);
    expect(elapsed).toBeLessThan(25);
  });

  test("isLocalObsHost identifica endereços locais e remotos corretamente", () => {
    expect(isLocalObsHost("localhost")).toBe(true);
    expect(isLocalObsHost("127.0.0.1")).toBe(true);
    expect(isLocalObsHost("::1")).toBe(true);
    expect(isLocalObsHost("192.168.1.96")).toBe(false);
    expect(isLocalObsHost("100.116.85.4")).toBe(false);
  });

  test("ObsWebSocketClient com host remoto não executa sondagens locais", async () => {
    let localProbeCalled = false;
    const client = new ObsWebSocketClient(
      {
        enabled: true,
        host: "192.168.1.96",
        port: 4455,
        password: "",
        scenes: { matchscore: "Score" },
      },
      {
        detectObsProcessState: () => {
          localProbeCalled = true;
          return "visible";
        },
        detectPreviewProjectors: async () => {
          localProbeCalled = true;
          return 1;
        },
      }
    );

    const procState = client.refreshProcessState();
    const procStateAsync = await client.refreshProcessStateAsync();
    const projState = await client.refreshPreviewProjectorState();

    expect(localProbeCalled).toBe(false);
    expect(procState).toBe("unknown");
    expect(procStateAsync).toBe("unknown");
    expect(projState).toBe(null);
  });

  test("tickClock corre 1000 vezes em memória em poucos milissegundos", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matchday-perf-"));
    const { store } = MatchdayStore.open(join(dir, "matchday.db"));
    const writer = new TxtWriter(join(dir, "scoreboard"));
    const config = {
      configPath: join(dir, "config.json"),
      exeDir: dir,
      outputDir: join(dir, "scoreboard"),
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
      accessPinHash: "test",
      tokenSecret: "0123456789abcdef0123456789abcdef",
      tokenTtlMs: 60_000,
    };
    const server = new MatchdayServer({
      config,
      store,
      writer,
    });

    server.applyCommandAction({ type: "START_CLOCK" });

    const start = performance.now();
    let baseTime = Date.now();
    for (let i = 0; i < 1000; i++) {
      server.tickClock(baseTime + i * 100);
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(100); // 1000 ticks < 100ms (média < 0.1ms/tick)

    await server.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
