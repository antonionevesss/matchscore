import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hashPin, randomTokenSecret } from "../src/auth";
import { loadConfig } from "../src/config";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "mc-config-"));
}

test("primeiro arranque grava outputDir relativo 'scoreboard' e resolve junto do exe", () => {
  const dir = tempDir();
  try {
    const configPath = join(dir, "config.json");
    const config = loadConfig({ configPath });
    assert.equal(config.outputDir, join(dir, "scoreboard"));
    const stored = JSON.parse(readFileSync(configPath, "utf8")) as {
      outputDir: string;
      pinHash?: string;
      tokenSecret: string;
      telescore: { enabled: boolean; processName: string };
      openBrowserOnStart: boolean;
      obs: { enabled: boolean; host: string; port: number; scenes: { matchscore: string } };
    };
    assert.equal(stored.outputDir, "scoreboard");
    assert.equal(stored.telescore.enabled, true);
    assert.equal(stored.telescore.processName, "TeleScore.exe");
    assert.equal(stored.openBrowserOnStart, true);
    assert.equal(stored.pinHash, undefined);
    assert.equal(existsSync(join(dir, "pin.txt")), false);
    assert.equal(stored.obs.enabled, false);
    assert.equal(stored.obs.host, "127.0.0.1");
    assert.equal(stored.obs.port, 4455);
    assert.equal(stored.obs.scenes.matchscore, "Cena 1 - Matchscore");
    assert.ok(stored.tokenSecret.length >= 32);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outputDir relativo num config existente resolve contra a pasta do config", () => {
  const dir = tempDir();
  try {
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        outputDir: "scoreboard",
        tokenSecret: randomTokenSecret(),
        pinHash: hashPin("123456"),
      }),
    );
    const config = loadConfig({ configPath });
    assert.equal(config.outputDir, join(dir, "scoreboard"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outputDir absoluto num config existente mantém-se", () => {
  const dir = tempDir();
  try {
    const configPath = join(dir, "config.json");
    const absolute = join(dir, "custom", "obs");
    writeFileSync(
      configPath,
      JSON.stringify({
        outputDir: absolute,
        tokenSecret: randomTokenSecret(),
        pinHash: hashPin("123456"),
      }),
    );
    const config = loadConfig({ configPath });
    assert.equal(config.outputDir, absolute);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
