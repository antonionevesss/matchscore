import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DEFAULT_TXT_FILES, type TxtFileNames } from "./writer";
import { hashAccessPassword, isValidAccessPin, randomAccessPin, randomTokenSecret } from "./auth";

export interface AppConfig {
  configPath: string;
  exeDir: string;
  outputDir: string;
  files: TxtFileNames;
  openBrowserOnStart: boolean;
  port: number;
  bind: string;
  obs?: ObsConfig;
  /** Hash scrypt do PIN operacional. */
  accessPinHash: string;
  tokenSecret: string;
  tokenTtlMs: number;
}

export interface ObsConfig {
  enabled: boolean;
  host: string;
  port: number;
  password: string;
  /** Optional absolute path to OBS; empty means automatic detection. */
  executablePath?: string;
  /** Chave interna → nome exato da cena no OBS. */
  scenes: Record<string, string>;
  /** Rótulos opcionais dos botões; sem rótulo a interface deriva-o da chave. */
  sceneLabels?: Record<string, string>;
  /** Opções do projetor fullscreen do Preview do OBS. */
  previewProjector?: ObsPreviewProjectorConfig;
}

export interface ObsPreviewProjectorConfig {
  enabled: boolean;
  /** Índice devolvido pelo OBS; -1 abre numa janela. */
  monitorIndex: number;
  /** Abre automaticamente quando a ligação ao OBS fica pronta. */
  autoOpen: boolean;
}

export const DEFAULT_OBS_CONFIG: ObsConfig = {
  enabled: false,
  host: "127.0.0.1",
  port: 4455,
  password: "",
  executablePath: "",
  scenes: {
    matchscore: "Match score",
    goal: "Goal alert",
    sponsors: "Sponsors",
    music: "Music",
  },
  sceneLabels: {},
  previewProjector: {
    enabled: true,
    monitorIndex: 1,
    autoOpen: true,
  },
};

const OBS_SCENE_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/i;
const OBS_RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function isValidObsSceneKey(value: string): boolean {
  return OBS_SCENE_KEY_PATTERN.test(value) && !OBS_RESERVED_KEYS.has(value.toLowerCase());
}

function normalizeSceneMap(raw: unknown, fallback: Record<string, string>): Record<string, string> {
  const source = (raw ?? {}) as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(fallback)) {
    if (isValidObsSceneKey(key) && value.trim()) result[key] = value.trim();
  }
  for (const [key, value] of Object.entries(source)) {
    if (!isValidObsSceneKey(key) || typeof value !== "string" || !value.trim()) continue;
    result[key] = value.trim();
  }
  return result;
}

function normalizeSceneLabels(raw: unknown, scenes: Record<string, string>, fallback: Record<string, string> = {}): Record<string, string> {
  const source = (raw ?? {}) as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(fallback)) {
    if (isValidObsSceneKey(key) && typeof value === "string" && value.trim()) result[key] = value.trim();
  }
  for (const [key, value] of Object.entries(source)) {
    if (!isValidObsSceneKey(key) || typeof value !== "string" || !value.trim()) continue;
    result[key] = value.trim();
  }
  // A label is optional. The web panel uses a translated known label or a
  // humanised key when no custom label was configured.
  return Object.fromEntries(Object.entries(result).filter(([key]) => scenes[key] !== undefined));
}

function normalizePreviewProjector(
  raw: unknown,
  fallback: ObsPreviewProjectorConfig,
): ObsPreviewProjectorConfig {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const monitorIndex = Number(source.monitorIndex ?? fallback.monitorIndex);
  return {
    enabled: source.enabled === undefined ? fallback.enabled : source.enabled === true,
    monitorIndex: Number.isInteger(monitorIndex) && monitorIndex >= -1 && monitorIndex <= 1024
      ? monitorIndex
      : fallback.monitorIndex,
    autoOpen: source.autoOpen === undefined ? fallback.autoOpen : source.autoOpen === true,
  };
}

export function normalizeObsConfig(raw: unknown, fallback: ObsConfig = DEFAULT_OBS_CONFIG): ObsConfig {
  const source = (raw ?? {}) as Record<string, unknown>;
  const port = Number(source.port ?? fallback.port);
  const scenes = normalizeSceneMap(source.scenes, fallback.scenes);
  return {
    enabled: source.enabled === undefined ? fallback.enabled : source.enabled === true,
    host: String(source.host ?? fallback.host).trim() || fallback.host,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback.port,
    password: String(source.password ?? fallback.password),
    executablePath: String(source.executablePath ?? fallback.executablePath ?? "").trim(),
    scenes,
    sceneLabels: normalizeSceneLabels(source.sceneLabels, scenes, fallback.sceneLabels),
    previewProjector: normalizePreviewProjector(
      source.previewProjector,
      fallback.previewProjector ?? DEFAULT_OBS_CONFIG.previewProjector!,
    ),
  };
}

export interface LoadConfigOptions {
  configPath?: string;
  setPin?: string | null;
}

const DEFAULT_PORT = 8080;
const DEFAULT_BIND = "0.0.0.0";
const DEFAULT_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
/**
 * Pasta de saída por omissão. No pacote, o config vive em `data/` e aponta
 * para `../scoreboard`, mantendo os 5 ficheiros `.txt` fora dos dados internos.
 */
const DEFAULT_OUTPUT_DIR = "scoreboard";
const PACKAGED_OUTPUT_DIR = "../scoreboard";

function appBaseDir(): string {
  const exe = process.execPath;
  const base = exe.toLowerCase().endsWith("\\bun.exe") || exe.toLowerCase().endsWith("/bun") || exe.endsWith("bun");
  return base ? process.cwd() : dirname(exe);
}

function defaultConfigPath(): string {
  return join(appBaseDir(), "data", "config.json");
}

function normalize(raw: unknown, configPath: string): AppConfig {
  const base = dirname(resolve(configPath));
  const r = (raw ?? {}) as Record<string, unknown>;
  const files = (r.files ?? {}) as Record<string, unknown>;
  const outputDir = String(r.outputDir ?? DEFAULT_OUTPUT_DIR);
  const port = Number(r.port ?? DEFAULT_PORT);
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
    openBrowserOnStart: r.openBrowserOnStart !== false,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT,
    bind: String(r.bind ?? DEFAULT_BIND),
    obs: normalizeObsConfig(r.obs),
    accessPinHash: String(r.accessPinHash ?? ""),
    tokenSecret: String(r.tokenSecret ?? ""),
    tokenTtlMs: Number(r.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS),
  };
}

function defaultPayload(
  outputDir = DEFAULT_OUTPUT_DIR,
  accessPinHash = hashAccessPassword(randomAccessPin()),
): Record<string, unknown> {
  return {
    outputDir,
    files: DEFAULT_TXT_FILES,
    openBrowserOnStart: true,
    port: DEFAULT_PORT,
    bind: DEFAULT_BIND,
    obs: DEFAULT_OBS_CONFIG,
    accessPinHash,
    tokenSecret: randomTokenSecret(),
    tokenTtlMs: DEFAULT_TOKEN_TTL_MS,
  };
}

function writeConfigFile(configPath: string, payload: Record<string, unknown>): void {
  mkdirSync(dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8" });
    renameSync(tempPath, configPath);
  } catch (error) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // Melhor esforço de limpeza.
    }
    throw error;
  }
}

function readJsonFile(configPath: string): unknown {
  return JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
}

function configPayload(config: AppConfig): Record<string, unknown> {
  return {
    outputDir: config.outputDir,
    files: config.files,
    openBrowserOnStart: config.openBrowserOnStart,
    port: config.port,
    bind: config.bind,
    accessPinHash: config.accessPinHash,
    tokenSecret: config.tokenSecret,
    tokenTtlMs: config.tokenTtlMs,
  };
}

export function saveObsConfig(config: AppConfig, obs: ObsConfig): void {
  let payload: Record<string, unknown>;
  if (existsSync(config.configPath)) {
    payload = readJsonFile(config.configPath) as Record<string, unknown>;
  } else {
    payload = configPayload(config);
  }
  delete payload.telescore;
  payload.obs = obs;
  writeConfigFile(config.configPath, payload);
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const configPath = options.configPath
    ? resolve(options.configPath)
    : process.env.MATCHDAY_CONTROL_CONFIG?.trim() || defaultConfigPath();

  if (options.setPin != null) {
    const pin = options.setPin.trim();
    if (!isValidAccessPin(pin)) throw new Error("The PIN must contain exactly 6 digits.");
    const config = loadConfig({ configPath });
    const payload = readJsonFile(config.configPath) as Record<string, unknown>;
    payload.accessPinHash = hashAccessPassword(pin);
    writeConfigFile(config.configPath, payload);
    try {
      unlinkSync(join(dirname(config.configPath), "initial-pin.txt"));
    } catch {
      // O PIN inicial pode já ter sido removido.
    }
    console.log("[config] PIN updated.");
    process.exit(0);
  }

  if (existsSync(configPath)) {
    let raw: unknown;
    try {
      raw = readJsonFile(configPath);
    } catch (error) {
      throw new Error(`Invalid configuration at ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Invalid configuration at ${configPath}: expected a JSON object.`);
    }
    const source = { ...(raw as Record<string, unknown>) };
    let changed = false;
    if ("telescore" in source) {
      delete source.telescore;
      changed = true;
    }
    if ("pinHash" in source) {
      delete source.pinHash;
      changed = true;
    }
    if (source.accessPinHash === undefined || source.accessPinHash === null || source.accessPinHash === "") {
      const initialPin = randomAccessPin();
      source.accessPinHash = hashAccessPassword(initialPin);
      writeFileSync(join(dirname(configPath), "initial-pin.txt"), `${initialPin}\n`, "utf8");
      changed = true;
    }
    if (source.tokenSecret === undefined || source.tokenSecret === null || source.tokenSecret === "") {
      source.tokenSecret = randomTokenSecret();
      changed = true;
    }
    if (changed) writeConfigFile(configPath, source);
    const config = normalize(source, configPath);
    if (!/^[0-9a-f]{32,}$/i.test(config.tokenSecret)) {
      throw new Error(`tokenSecret in ${configPath} must contain at least 32 hexadecimal characters.`);
    }
    if (!verifyPinHashShape(config.accessPinHash)) {
      throw new Error(`accessPinHash in ${configPath} is invalid.`);
    }
    return config;
  }

  // Primeiro arranque: guarda os dados em data/ e deixa scoreboard separado.
  const usesPackagedDefaults = !options.configPath && !process.env.MATCHDAY_CONTROL_CONFIG?.trim();
  const initialPin = randomAccessPin();
  const payload = defaultPayload(
    usesPackagedDefaults ? PACKAGED_OUTPUT_DIR : DEFAULT_OUTPUT_DIR,
    hashAccessPassword(initialPin),
  );
  writeConfigFile(configPath, payload);
  writeFileSync(join(dirname(configPath), "initial-pin.txt"), `${initialPin}\n`, "utf8");
  return normalize(payload, configPath);
}

function verifyPinHashShape(value: string): boolean {
  const [prefix, salt, digest] = value.split("$");
  return prefix === "scrypt" && Boolean(salt && digest && /^[0-9a-f]{64}$/i.test(digest));
}
