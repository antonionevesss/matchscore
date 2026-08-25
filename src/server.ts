import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "./config";
import { MatchdayStore } from "./store";
import { TxtWriter } from "./writer";
import { MatchdayServer, APP_VERSION } from "./api";
import { keepSystemAwake } from "./power";
import { configureDiagnostics, diagnosticError } from "./diagnostics";

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

let fatalShutdown: ((code: number) => void) | null = null;
const startupLogPath = configureDiagnostics({
  configPath: argValue("--config"),
  logPath: argValue("--log"),
});

function reportFatal(kind: string, reason: unknown): void {
  console.error(`[fatal] ${kind}: ${diagnosticError(reason)}`);
  if (fatalShutdown) {
    fatalShutdown(1);
  } else {
    process.exit(1);
  }
}

// Registados antes de loadConfig/SQLite/Bun.serve: um erro de arranque deixa
// sempre uma explicação no log, mesmo quando o exe foi aberto por duplo clique.
process.on("uncaughtException", (error) => reportFatal("Uncaught exception", error));
process.on("unhandledRejection", (reason) => reportFatal("Unhandled rejection", reason));

function printHelp(): void {
  console.log(`Matchday Control v${APP_VERSION}

Usage:
  MatchdayControl.exe                   Start the server (creates config.json on first run)
  MatchdayControl.exe --config PATH     Use another configuration
  MatchdayControl.exe --log PATH        Write diagnostics to another log file
  MatchdayControl.exe --set-pin 123456  Set or update the operational PIN
  MatchdayControl.exe --print-pin       Show the initial PIN, if it still exists
  MatchdayControl.exe --help            Show this help

The initial PIN is generated randomly on first run. Save it and change it with
--set-pin after installing the application.`);
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
  console.log(`[server] Control available at http://localhost:${port} (local network: http://IP:${port})`);
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        console.log(`[server]   ${name}: http://${address.address}:${port}`);
      }
    }
  }
}

function centerText(value: string, width: number): string {
  const text = value.slice(0, width);
  const left = Math.floor((width - text.length) / 2);
  return `${" ".repeat(left)}${text}${" ".repeat(width - left - text.length)}`;
}

function printPinBox(pin: string): void {
  const width = 52;
  const border = `+${"-".repeat(width)}+`;
  const useColor = process.stdout.isTTY === true;
  const cyan = useColor ? "\x1b[96m" : "";
  const yellow = useColor ? "\x1b[93m" : "";
  const bold = useColor ? "\x1b[1m" : "";
  const reset = useColor ? "\x1b[0m" : "";
  const line = (text = "") => `${cyan}|${centerText(text, width)}|${reset}`;
  const pinLeft = Math.floor((width - pin.length) / 2);
  const pinRight = width - pinLeft - pin.length;
  const pinLine = `${cyan}|${" ".repeat(pinLeft)}${yellow}${bold}${pin}${reset}${cyan}${" ".repeat(pinRight)}|${reset}`;

  console.log("");
  console.log(`${cyan}${border}${reset}`);
  console.log(line("MATCHDAY CONTROL"));
  console.log(line("INITIAL PIN - SAVE IT"));
  console.log(line());
  console.log(pinLine);
  console.log(line());
  console.log(line("OPEN THE PANEL IN YOUR BROWSER"));
  console.log(line("USE THIS PIN TO SIGN IN"));
  console.log(line("CHANGE IT LATER: --set-pin 123456"));
  console.log(`${cyan}${border}${reset}`);
  console.log("");
}

function printInitialPin(configPath: string): void {
  const pinPath = join(dirname(configPath), "initial-pin.txt");
  if (!existsSync(pinPath)) return;
  const pin = readFileSync(pinPath, "utf8").trim();
  if (/^\d{6}$/.test(pin)) printPinBox(pin);
}

function openBrowser(url: string): void {
  try {
    const command =
      process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
    Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
    console.log(`[server] Opening the control panel in the browser: ${url}`);
  } catch (error) {
    console.warn(
      `[server] Could not open the browser: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function main(): void {
  console.log(`[diagnostics] Log file: ${startupLogPath}`);

  if (hasArg("--help") || hasArg("-h")) {
    printHelp();
    process.exit(0);
  }

  if (hasArg("--print-pin")) {
    const config = loadConfig({ configPath: argValue("--config") });
    const pinPath = join(dirname(config.configPath), "initial-pin.txt");
    if (existsSync(pinPath)) {
      printPinBox(readFileSync(pinPath, "utf8").trim());
    } else {
      console.log("PIN already set. To create a new one: --set-pin 123456");
    }
    process.exit(0);
  }

  const setPin = argValue("--set-pin");
  const config = loadConfig({ configPath: argValue("--config"), setPin: setPin ?? null });
  printInitialPin(config.configPath);
  const dataDir = dirname(config.configPath);

  const lockPath = join(dataDir, "matchday.lock");
  if (!acquireLock(lockPath)) {
    console.error(
      `[server] Another Matchday Control instance is already running. The Windows service may already be active. Check the panel at http://localhost:${config.port} or stop the scheduled task before opening another instance.`,
    );
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
      `[writer] Output directory is not writable (${config.outputDir}): ${error instanceof Error ? error.message : String(error)}`,
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
    console.log("[server] No active match. Open http://localhost:8080 on the host computer to configure the teams.");
  }

  const server = app.start();
  const powerRequest = keepSystemAwake();
  console.log("[power] Sleep, hibernation, and display shutdown disabled while the app is running.");

  if (storeResult.restoredFromBackup) {
    console.warn(`[server] Estado restaurado a partir de backup. ${storeResult.startupError ?? ""}`);
  }
  if (!filesOk) {
    console.error(`[server] Starting in degraded mode: ${writer.lastError ?? "OBS output unavailable"}.`);
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
      console.error(`[watchdog] Event loop blocked for ${lag}ms; exiting for automatic restart.`);
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
      powerRequest.release();
      store.close();
      releaseLock(lockPath);
      console.log("[server] Matchday Control stopped.");
      process.exit(code);
    });
  }

  fatalShutdown = shutdown;
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
}

try {
  main();
} catch (error) {
  reportFatal("Startup failure", error);
}
