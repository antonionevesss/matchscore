import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "./config";
import { MatchdayStore } from "./store";
import { TxtWriter } from "./writer";
import { MatchdayServer, APP_VERSION } from "./api";
import { FIXED_ACCESS_PASSWORD } from "./auth";

const WATCHDOG_INTERVAL_MS = 5_000;
const WATCHDOG_MAX_LAG_MS = 10_000;
const CLOCK_TICK_MS = 1_000;

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

function printHelp(): void {
  console.log(`Matchday Control v${APP_VERSION}

Uso:
  MatchdayControl.exe                 Arranca o servidor (cria config.json no primeiro arranque)
  MatchdayControl.exe --config PATH   Usa outra configuração
  MatchdayControl.exe --set-pin 1887  Confirma a palavra-passe fixa
  MatchdayControl.exe --print-pin     Mostra a palavra-passe fixa
  MatchdayControl.exe --help          Mostra esta ajuda

A palavra-passe operacional é fixa: ${FIXED_ACCESS_PASSWORD}.`);
}

function processAlive(pid: number): boolean {
  try {
    const result = Bun.spawnSync(["tasklist", "/FI", `PID eq ${pid}`, "/NH"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return new RegExp(`\\b${pid}\\b`).test(result.stdout.toString());
  } catch {
    // À cautela: se não conseguirmos verificar, assume-se vivo (não duplica).
    return true;
  }
}

function acquireLock(lockPath: string): boolean {
  try {
    writeFileSync(lockPath, String(process.pid), { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
  }

  let staleContent: string;
  try {
    staleContent = readFileSync(lockPath, "utf8");
    const pid = Number(staleContent.trim());
    if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) return false;
  } catch {
    staleContent = "";
  }

  try {
    if (readFileSync(lockPath, "utf8") !== staleContent) return false;
    unlinkSync(lockPath);
  } catch {
    return false;
  }

  try {
    writeFileSync(lockPath, String(process.pid), { encoding: "utf8", flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function releaseLock(lockPath: string): void {
  try {
    if (readFileSync(lockPath, "utf8").trim() === String(process.pid)) unlinkSync(lockPath);
  } catch {
    // já removido
  }
}

function logLanAddresses(port: number): void {
  console.log(`[server] Controlo disponível em http://localhost:${port} (rede local: http://IP:${port})`);
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        console.log(`[server]   ${name}: http://${address.address}:${port}`);
      }
    }
  }
}

function openBrowser(url: string): void {
  try {
    const command =
      process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
    Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
    console.log(`[server] A abrir o controlo no browser: ${url}`);
  } catch (error) {
    console.warn(
      `[server] Não foi possível abrir o browser: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function main(): void {
  if (hasArg("--help") || hasArg("-h")) {
    printHelp();
    process.exit(0);
  }

  if (hasArg("--print-pin")) {
    console.log(`PALAVRA-PASSE: ${FIXED_ACCESS_PASSWORD}`);
    process.exit(0);
  }

  const setPin = argValue("--set-pin");
  const config = loadConfig({ configPath: argValue("--config"), setPin: setPin ?? null });
  const dataDir = dirname(config.configPath);

  const lockPath = join(dataDir, "matchday.lock");
  if (!acquireLock(lockPath)) {
    console.error("[server] Outra instância do Matchday Control já está a correr.");
    process.exit(1);
  }

  const storeResult = MatchdayStore.open(join(dataDir, "matchday.db"));
  const store = storeResult.store;

  const writer = new TxtWriter(config.outputDir, config.files);
  let filesOk = true;
  try {
    writer.probe();
  } catch (error) {
    filesOk = false;
    console.error(
      `[writer] Diretoria de saída não escrevível (${config.outputDir}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const app = new MatchdayServer({ config, store, writer });

  const session = store.load();
  if (session.state) {
    writer.writeState(session.state, Date.now(), true);
    console.log(
      `[server] Estado restaurado · v${session.state.version} · ${session.state.homeTeam} ${session.state.homeScore}-${session.state.awayScore} ${session.state.awayTeam}`,
    );
  } else {
    console.log("[server] Sem controlo ativo. Abra http://localhost:8080 no PC e configure as equipas.");
  }

  const server = app.start();

  if (storeResult.restoredFromBackup) {
    console.warn(`[server] Estado restaurado a partir de backup. ${storeResult.startupError ?? ""}`);
  }
  if (!filesOk) {
    console.error(`[server] A arrancar em modo degradado: ${writer.lastError ?? "saída OBS indisponível"}.`);
  }
  console.log(`[server] Matchday Control v${APP_VERSION} a correr em ${server.url.host} · Scoreboard: ${config.outputDir}`);
  logLanAddresses(server.port ?? config.port);
  if (config.openBrowserOnStart) {
    openBrowser(`http://localhost:${server.port ?? config.port}`);
  }

  // Relógio: escreve os .txt uma vez por segundo (só quando o valor muda).
  setInterval(() => {
    const current = store.load().state;
    if (current) writer.writeState(current, Date.now(), false);
  }, CLOCK_TICK_MS);

  // Watchdog interno: se o event loop ficar preso >10s, sai para o supervisor reiniciar.
  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    const lag = now - lastTick - WATCHDOG_INTERVAL_MS;
    lastTick = now;
    if (lag > WATCHDOG_MAX_LAG_MS) {
      console.error(`[watchdog] Event loop bloqueado ${lag}ms; a sair para reinício automático.`);
      shutdown(1);
    }
  }, WATCHDOG_INTERVAL_MS);

  let shuttingDown = false;
  function shutdown(code: number): void {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      writer.probe();
    } catch {
      // sem escritas pendentes: o estado já está persistido a cada mutação
    }
    void app.stop().finally(() => {
      store.close();
      releaseLock(lockPath);
      console.log("[server] Matchday Control parado.");
      process.exit(code);
    });
  }

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  process.on("uncaughtException", (error) => {
    console.error(`[server] Erro fatal: ${error.stack ?? error}`);
    shutdown(1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`[server] Rejeição não tratada: ${String(reason)}`);
    shutdown(1);
  });
}

main();
