import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { embedFonts } from "./embed-fonts.ts";

const root = resolve(import.meta.dir, "..");
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });
const dataDir = join(dist, "data");
mkdirSync(dataDir, { recursive: true });
const scoreboardDir = join(dist, "scoreboard");
mkdirSync(scoreboardDir, { recursive: true });
function migrateRuntimeFile(name: string): void {
  const source = join(dist, name);
  const target = join(dataDir, name);
  if (!existsSync(source) || existsSync(target)) return;
  try {
    renameSync(source, target);
    console.log(`[build] migrado: ${name} → data/${name}`);
  } catch (error) {
    console.warn(`[build] não foi possível migrar ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

for (const file of ["config.json", "matchday.db", "matchday.db-shm", "matchday.db-wal", "matchday.db.bak", "matchday.db.bak2"]) {
  migrateRuntimeFile(file);
}

function processAlive(pid: number): boolean {
  try {
    const result = Bun.spawnSync(["tasklist", "/FI", `PID eq ${pid}`, "/NH"], { stdout: "pipe", stderr: "ignore" });
    return new RegExp(`\\b${pid}\\b`).test(result.stdout.toString());
  } catch {
    return true;
  }
}

function removeStaleLock(lockPath: string): void {
  if (!existsSync(lockPath)) return;
  try {
    const pid = Number(readFileSync(lockPath, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) return;
    unlinkSync(lockPath);
    console.log(`[build] removido lock antigo: ${lockPath}`);
  } catch {
    // Se não for possível confirmar que é antigo, preserva-se por segurança.
  }
}

removeStaleLock(join(dist, "matchday.lock"));
removeStaleLock(join(dataDir, "matchday.lock"));

// Artefactos de versões antigas do pacote; não são necessários para executar a app.
for (const file of ["config.example.json", "task.template.xml", "matchday-task.xml"]) {
  const stalePath = join(dist, file);
  if (existsSync(stalePath)) unlinkSync(stalePath);
}
const staleScoreboardReadme = join(scoreboardDir, "README.txt");
if (existsSync(staleScoreboardReadme)) unlinkSync(staleScoreboardReadme);

const migratedConfig = join(dataDir, "config.json");
if (existsSync(migratedConfig)) {
  try {
    const payload = JSON.parse(readFileSync(migratedConfig, "utf8")) as Record<string, unknown>;
    if (payload.outputDir === "scoreboard") {
      payload.outputDir = "../scoreboard";
      writeFileSync(migratedConfig, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      console.log("[build] atualizado outputDir para a nova estrutura data/scoreboard.");
    }
  } catch (error) {
    console.warn(`[build] não foi possível ajustar data/config.json: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log("[build] a compilar MatchdayControl.exe…");
embedFonts();
const result = Bun.spawnSync(
  [
    "bun",
    "build",
    "--compile",
    join(root, "src", "server.ts"),
    "--outfile",
    join(dist, "MatchdayControl.exe"),
    "--minify",
    "--loader",
    ".html:text",
    "--windows-title=Matchday Control",
    "--windows-publisher=Matchday Control contributors",
    "--windows-description=Controlo do marcador e cenas OBS",
    "--windows-version=1.5.0.0",
    "--windows-copyright=Matchday Control contributors",
  ],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
if (result.exitCode !== 0) {
  console.error("[build] falhou.");
  process.exit(result.exitCode ?? 1);
}

for (const file of ["install-service.cmd", "uninstall-service.cmd"]) {
  copyFileSync(join(root, file), join(dist, file));
}

console.log("[build] concluído:");
console.log(`  ${join(dist, "MatchdayControl.exe")}`);
console.log(`  ${join(dist, "scoreboard")} (pasta dos ficheiros .txt)`);
console.log(`  ${join(dist, "data")} (configuração e dados internos)`);
console.log(`  ${join(dist, "install-service.cmd")}`);
console.log(`  ${join(dist, "uninstall-service.cmd")}`);
