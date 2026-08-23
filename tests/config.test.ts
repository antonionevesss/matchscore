import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { randomTokenSecret } from "../src/auth";
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
      accessPinHash: string;
      tokenSecret: string;
      openBrowserOnStart: boolean;
      obs: { enabled: boolean; host: string; port: number; scenes: { matchscore: string } };
    };
    assert.equal(stored.outputDir, "scoreboard");
    assert.equal("telescore" in stored, false);
    assert.equal(stored.openBrowserOnStart, true);
    assert.match(stored.accessPinHash, /^scrypt\$/);
    assert.equal(existsSync(join(dir, "pin.txt")), false);
    assert.equal(stored.obs.enabled, false);
    assert.equal(stored.obs.host, "127.0.0.1");
    assert.equal(stored.obs.port, 4455);
    assert.equal(stored.obs.scenes.matchscore, "Marcador");
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
        pinHash: "legacy-pin-hash-ignored",
        telescore: { enabled: true, processName: "legacy.exe" },
      }),
    );
    const config = loadConfig({ configPath });
    assert.equal(config.outputDir, join(dir, "scoreboard"));
    const stored = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    assert.equal("telescore" in stored, false);
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
        pinHash: "legacy-pin-hash-ignored",
      }),
    );
    const config = loadConfig({ configPath });
    assert.equal(config.outputDir, absolute);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config existente sem tokenSecret recebe um segredo aleatório", () => {
  const dir = tempDir();
  try {
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ tokenSecret: "" }));
    const config = loadConfig({ configPath });
    assert.match(config.tokenSecret, /^[0-9a-f]{32,}$/i);
    const persisted = JSON.parse(readFileSync(configPath, "utf8")) as { tokenSecret: string };
    assert.equal(persisted.tokenSecret, config.tokenSecret);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tokenSecret não hexadecimal é rejeitado", () => {
  const dir = tempDir();
  try {
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ tokenSecret: "segredo previsível que não é hexadecimal" }));
    assert.throws(() => loadConfig({ configPath }), /caracteres hexadecimais/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
