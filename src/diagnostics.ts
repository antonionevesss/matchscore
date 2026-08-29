import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const LOG_FILE_NAME = "matchday.log";

type DiagnosticLevel = "INFO" | "WARN" | "ERROR";

let activeLogPath: string | null = null;
let consoleForwardingInstalled = false;

const nativeConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function runtimeDirectory(): string {
  const executable = process.execPath.replaceAll("\\", "/").toLowerCase();
  const isBunRuntime = executable.endsWith("/bun") || executable.endsWith("/bun.exe") || executable === "bun";
  return isBunRuntime ? resolve(process.cwd()) : dirname(process.execPath);
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))];
}

function candidateLogPaths(options: { configPath?: string; logPath?: string }): string[] {
  const paths: string[] = [];
  if (options.logPath?.trim()) paths.push(options.logPath.trim());
  if (options.configPath?.trim()) paths.push(join(dirname(resolve(options.configPath)), LOG_FILE_NAME));

  const runtimeDir = runtimeDirectory();
  paths.push(join(runtimeDir, "data", LOG_FILE_NAME));
  paths.push(join(runtimeDir, LOG_FILE_NAME));
  paths.push(join(tmpdir(), "MatchdayControl", LOG_FILE_NAME));
  return uniquePaths(paths);
}

function formatValue(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

function formatArguments(values: unknown[]): string {
  return values.map(formatValue).join(" ");
}

function rotateIfNeeded(path: string): void {
  try {
    if (!existsSync(path) || statSync(path).size < MAX_LOG_BYTES) return;
    const previousPath = `${path}.1`;
    try {
      if (existsSync(previousPath)) unlinkSync(previousPath);
    } catch {
      // A full log must never prevent the application from starting.
    }
    renameSync(path, previousPath);
  } catch {
    // Best effort only: logging must never become a startup failure.
  }
}

function append(level: DiagnosticLevel, message: string): void {
  if (!activeLogPath) return;
  try {
    rotateIfNeeded(activeLogPath);
    appendFileSync(activeLogPath, `${new Date().toISOString()} [${level}] ${message}\n`, "utf8");
  } catch {
    // There is no safe place left to report a logging failure.
  }
}

function installConsoleForwarding(): void {
  if (consoleForwardingInstalled) return;
  consoleForwardingInstalled = true;

  console.log = (...values: unknown[]) => {
    nativeConsole.log(...values);
    append("INFO", formatArguments(values));
  };
  console.warn = (...values: unknown[]) => {
    nativeConsole.warn(...values);
    append("WARN", formatArguments(values));
  };
  console.error = (...values: unknown[]) => {
    nativeConsole.error(...values);
    append("ERROR", formatArguments(values));
  };
}

/**
 * Configura o diagnóstico antes de qualquer trabalho de arranque.
 * O primeiro caminho escrevível é usado, para ainda haver um log quando a
 * pasta do executável ou a pasta de dados não tiver permissões suficientes.
 */
export function configureDiagnostics(options: { configPath?: string; logPath?: string } = {}): string {
  const paths = candidateLogPaths(options);
  for (const path of paths) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${new Date().toISOString()} [INFO] --- Matchday Control startup ---\n`, "utf8");
      activeLogPath = path;
      installConsoleForwarding();
      return path;
    } catch {
      // Tenta o próximo local (por exemplo, %TEMP%) antes de desistir.
    }
  }

  // Mantém uma referência útil para a mensagem de erro, mesmo sem conseguir
  // criar o ficheiro. O processo nunca deve falhar apenas por falta de log.
  activeLogPath = paths[0] ?? join(runtimeDirectory(), "data", LOG_FILE_NAME);
  return activeLogPath;
}

export function diagnosticError(error: unknown): string {
  return formatValue(error);
}
