import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DEFAULT_TXT_FILES, type TxtFileNames } from "./writer";
import { FIXED_ACCESS_PASSWORD, randomTokenSecret } from "./auth";

export interface AppConfig {
  configPath: string;
  exeDir: string;
  outputDir: string;
  files: TxtFileNames;
  teleScore: TeleScoreConfig;
  openBrowserOnStart: boolean;
  port: number;
  bind: string;
  obs?: ObsConfig;
  /** Campo legado: é lido para compatibilidade, mas nunca é usado. */
  pinHash: string;
  tokenSecret: string;
  tokenTtlMs: number;
}

export interface ObsConfig {
  enabled: boolean;
  host: string;
  port: number;
  password: string;
  scenes: {
    matchscore: string;
    goal: string;
    sponsors: string;
  };
}

export const DEFAULT_OBS_CONFIG: ObsConfig = {
  enabled: false,
  host: "127.0.0.1",
  port: 4455,
  password: "",
  scenes: {
    matchscore: "Cena 1 - Matchscore",
    goal: "Cena 2 - Golo",
    sponsors: "Cena 3 - Sponsors",
  },
};

export function normalizeObsConfig(raw: unknown, fallback: ObsConfig = DEFAULT_OBS_CONFIG): ObsConfig {
  const source = (raw ?? {}) as Record<string, unknown>;
  const scenes = (source.scenes ?? {}) as Record<string, unknown>;
  const port = Number(source.port ?? fallback.port);
  return {
    enabled: source.enabled === undefined ? fallback.enabled : source.enabled === true,
    host: String(source.host ?? fallback.host).trim() || fallback.host,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback.port,
    password: String(source.password ?? fallback.password),
    scenes: {
      matchscore: String(scenes.matchscore ?? fallback.scenes.matchscore).trim() || fallback.scenes.matchscore,
      goal: String(scenes.goal ?? fallback.scenes.goal).trim() || fallback.scenes.goal,
      sponsors: String(scenes.sponsors ?? fallback.scenes.sponsors).trim() || fallback.scenes.sponsors,
    },
  };
}

export interface TeleScoreConfig {
  enabled: boolean;
  /** null = mesma pasta de saída (outputDir). */
  watchDir: string | null;
  pollMs: number;
  adoptTeams: boolean;
  adoptScores: boolean;
  adoptClock: boolean;
  /** Reservado: os ficheiros Period.txt/Period Text.txt não são escritos (OBS não os lê). */
  writePeriodFiles: boolean;
  processName: string | null;
}

export interface LoadConfigOptions {
  configPath?: string;
  setPin?: string | null;
  printPin?: boolean;
}

const DEFAULT_PORT = 8080;
const DEFAULT_BIND = "0.0.0.0";
const DEFAULT_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
/**
 * Pasta de saída por omissão, relativa ao executável: os 5 ficheiros `.txt`
 * são escritos em `scoreboard` junto do exe (em dev/build: dist/scoreboard).
 */
const DEFAULT_OUTPUT_DIR = "scoreboard";

function appBaseDir(): string {
  const exe = process.execPath;
  const base = exe.toLowerCase().endsWith("\\bun.exe") || exe.toLowerCase().endsWith("/bun") || exe.endsWith("bun");
  return base ? process.cwd() : dirname(exe);
}

function defaultConfigPath(): string {
  return join(appBaseDir(), "config.json");
}

function normalize(raw: unknown, configPath: string): AppConfig {
  const base = dirname(resolve(configPath));
  const r = (raw ?? {}) as Record<string, unknown>;
  const files = (r.files ?? {}) as Record<string, unknown>;
  const teleScore = (r.telescore ?? {}) as Record<string, unknown>;
  const outputDir = String(r.outputDir ?? DEFAULT_OUTPUT_DIR);
  const port = Number(r.port ?? DEFAULT_PORT);
  const pollMs = Number(teleScore.pollMs ?? 500);
  const rawWatchDir =
    typeof teleScore.watchDir === "string" && teleScore.watchDir.trim() ? String(teleScore.watchDir) : null;
  return {
    configPath,
    exeDir: base,
    outputDir: isAbsolute(outputDir) ? outputDir : resolve(base, outputDir),
    files: {
      homeName: String(files.homeName ?? DEFAULT_TXT_FILES.homeName),
      homeScore: String(files.homeScore ?? DEFAULT_TXT_FILES.homeScore),
      awayName: String(files.awayName ?? DEFAULT_TXT_FILES.awayName),
      awayScore: String(files.awayScore ?? DEFAULT_TXT_FILES.awayScore),
      clock: String(files.clock ?? DEFAULT_TXT_FILES.clock),
    },
    teleScore: {
      enabled: teleScore.enabled !== false,
      watchDir: rawWatchDir ? (isAbsolute(rawWatchDir) ? rawWatchDir : resolve(base, rawWatchDir)) : null,
      pollMs: Number.isFinite(pollMs) ? Math.min(5000, Math.max(100, Math.floor(pollMs))) : 500,
      adoptTeams: teleScore.adoptTeams !== false,
      adoptScores: teleScore.adoptScores !== false,
      adoptClock: teleScore.adoptClock !== false,
      writePeriodFiles: teleScore.writePeriodFiles === true,
      processName:
        typeof teleScore.processName === "string" && teleScore.processName.trim() ? teleScore.processName.trim() : null,
    },
    openBrowserOnStart: r.openBrowserOnStart !== false,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT,
    bind: String(r.bind ?? DEFAULT_BIND),
    obs: normalizeObsConfig(r.obs),
    pinHash: String(r.pinHash ?? ""),
    tokenSecret: String(r.tokenSecret ?? ""),
    tokenTtlMs: Number(r.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS),
  };
}

function defaultPayload(): Record<string, unknown> {
  return {
    outputDir: DEFAULT_OUTPUT_DIR,
    files: DEFAULT_TXT_FILES,
    telescore: {
      enabled: true,
      watchDir: null,
      pollMs: 500,
      adoptTeams: true,
      adoptScores: true,
      adoptClock: true,
      writePeriodFiles: false,
      processName: "TeleScore.exe",
    },
    openBrowserOnStart: true,
    port: DEFAULT_PORT,
    bind: DEFAULT_BIND,
    obs: DEFAULT_OBS_CONFIG,
    tokenSecret: randomTokenSecret(),
    tokenTtlMs: DEFAULT_TOKEN_TTL_MS,
  };
}

function writeConfigFile(configPath: string, payload: Record<string, unknown>): void {
  writeFileSync(configPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8" });
}

export function saveObsConfig(config: AppConfig, obs: ObsConfig): void {
  let payload: Record<string, unknown>;
  if (existsSync(config.configPath)) {
    payload = JSON.parse(readFileSync(config.configPath, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
  } else {
    payload = {
      outputDir: config.outputDir,
      files: config.files,
      telescore: config.teleScore,
      openBrowserOnStart: config.openBrowserOnStart,
      port: config.port,
      bind: config.bind,
      tokenSecret: config.tokenSecret,
      tokenTtlMs: config.tokenTtlMs,
    };
  }
  payload.obs = obs;
  writeConfigFile(config.configPath, payload);
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const configPath = options.configPath
    ? resolve(options.configPath)
    : process.env.MATCHDAY_CONTROL_CONFIG?.trim() || defaultConfigPath();

  if (options.setPin != null) {
    if (options.setPin.trim() !== FIXED_ACCESS_PASSWORD) {
      throw new Error(`A palavra-passe é fixa e só pode ser ${FIXED_ACCESS_PASSWORD}.`);
    }
    console.log(`[config] A palavra-passe fixa é ${FIXED_ACCESS_PASSWORD}; não existe configuração variável.`);
    process.exit(0);
  }

  if (existsSync(configPath)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
    } catch (error) {
      throw new Error(`Configuração inválida em ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const config = normalize(raw, configPath);
    if (!config.tokenSecret || config.tokenSecret.length < 32) {
      throw new Error(`Falta um tokenSecret válido (32+ caracteres hex) em ${configPath}.`);
    }
    return config;
  }

  // Primeiro arranque: cria config.json com segredo e configuração OBS desativada.
  const payload = defaultPayload();
  writeConfigFile(configPath, payload);
  return normalize(payload, configPath);
}
