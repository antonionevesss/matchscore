import assert from "node:assert/strict";
import test from "node:test";
import { launchObs } from "../src/obs-launcher";

test("launcher do OBS não inicia outra instância quando já está aberto", () => {
  let spawned = false;
  const result = launchObs("", {
    platform: "win32",
    isRunning: () => true,
    spawn: () => { spawned = true; },
  });

  assert.deepEqual(result, { alreadyRunning: true, executablePath: "obs64.exe" });
  assert.equal(spawned, false);
});

test("launcher do OBS usa o caminho configurado", () => {
  let spawnedPath = "";
  let spawnedOptions: { cwd: string; detached: boolean; windowsHide: boolean } | undefined;
  const configuredPath = "C:\\OBS\\bin\\64bit\\obs64.exe";
  const result = launchObs(configuredPath, {
    platform: "win32",
    isRunning: () => false,
    exists: (path) => path === configuredPath,
    spawn: (path, options) => { spawnedPath = path; spawnedOptions = options; },
  });

  assert.deepEqual(result, { alreadyRunning: false, executablePath: configuredPath });
  assert.equal(spawnedPath, configuredPath);
  assert.deepEqual(spawnedOptions, {
    cwd: "C:\\OBS\\bin\\64bit",
    detached: true,
    windowsHide: false,
  });
});

test("launcher do OBS não duplica um processo escondido", () => {
  let spawned = false;
  const result = launchObs("C:\\OBS\\obs64.exe", {
    platform: "win32",
    processState: () => "hidden",
    exists: () => true,
    spawn: () => { spawned = true; },
  });

  assert.deepEqual(result, {
    alreadyRunning: true,
    executablePath: "C:\\OBS\\obs64.exe",
    processState: "hidden",
  });
  assert.equal(spawned, false);
});

test("launcher do OBS procura a instalação habitual quando não há caminho configurado", () => {
  let spawnedPath = "";
  const installedPath = "C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe";
  const result = launchObs("", {
    platform: "win32",
    env: { ProgramFiles: "C:\\Program Files" },
    isRunning: () => false,
    exists: (path) => path === installedPath,
    spawn: (path) => { spawnedPath = path; },
  });

  assert.equal(result.alreadyRunning, false);
  assert.equal(result.executablePath, installedPath);
  assert.equal(spawnedPath, installedPath);
});

test("launcher do OBS explica quando o caminho configurado não existe", () => {
  assert.throws(
    () => launchObs("C:\\Missing\\obs64.exe", {
      platform: "win32",
      isRunning: () => false,
      exists: () => false,
    }),
    /OBS executable not found at configured path/,
  );
});
