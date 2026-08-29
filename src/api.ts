import type { Server } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInitialState, currentClockSeconds, normalizeTeamName, type MatchdayState } from "./domain/matchday";
import { applyCommand, isMatchdayCommandAction, type MatchdayCommandAction } from "./commands";
import { verifyAccessPassword, verifyToken, signToken, type TokenVerification } from "./auth";
import { MatchdayStore, ConflictError } from "./store";
import { TxtWriter } from "./writer";
import { DEFAULT_OBS_CONFIG, isValidObsSceneKey, normalizeObsConfig, saveObsConfig, type AppConfig, type ObsConfig } from "./config";
import { ObsWebSocketClient, type ObsSceneKey, type PreviewProjectorResult } from "./obs";
import { focusObsWindow, launchObs as launchObsProcess, type ObsLaunchResult } from "./obs-launcher";
import { isLogCategory, isLogLevel, PersistentLogStore, type AppLogEvent, type LogCategory, type LogLevel } from "./log";
import embeddedUi from "./ui/index.html";

export const APP_VERSION = "1.8.1";

type BunServer = Server<undefined>;

/**
 * Em modo compilado, o HTML vem embutido no exe (loader ".html" → "text").
 * Em dev/testes o import resolve como indefinido; lê-se do source tree.
 */
function loadUiHtml(): string {
  const embedded = embeddedUi as unknown;
  if (typeof embedded === "string" && embedded.length > 0) return embedded;
  return readFileSync(join(import.meta.dir, "ui", "index.html"), "utf8");
}

const UI_HTML = loadUiHtml();

export interface MatchdaySnapshot {
  state: MatchdayState | null;
  undoAvailable: boolean;
  /** Valor autoritativo usado pelo Clock.txt e enviado a todos os painéis. */
  clockSeconds: number;
  /** Instante do servidor usado como referência para sincronizar os painéis. */
  serverNowMs: number;
}

export interface HealthReport {
  checkedAt: string;
  status: "ok" | "degraded";
  uptime: number;
  stateVersion: number | null;
  filesOk: boolean;
  lastError: string | null;
  lastWriteAt: string | null;
  obs: ReturnType<ObsWebSocketClient["status"]>;
  version: string;
  port: number;
  serverNowMs: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const SSE_HEARTBEAT_MS = 15_000;
const MAX_AUTH_ATTEMPTS = 5;
const AUTH_WINDOW_MS = 60_000;
const AUTH_LOCK_MS = 60_000;
const SSE_ENCODER = new TextEncoder();
interface AuthAttempt {
  count: number;
  resetAt: number;
  lockedUntil: number;
}

export class MatchdayServer {
  private readonly store: MatchdayStore;
  private readonly writer: TxtWriter;
  private readonly config: AppConfig;
  private readonly obs: ObsWebSocketClient;
  private readonly launchObsProcess: (configuredPath?: string) => ObsLaunchResult;
  private readonly focusObsProcess: () => boolean;
  private readonly localCheck: (request: Request, server: BunServer) => boolean;
  private readonly subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private readonly authAttempts = new Map<string, AuthAttempt>();
  private readonly logStore: PersistentLogStore;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private server: BunServer | null = null;

  constructor(options: {
    config: AppConfig;
    store: MatchdayStore;
    writer: TxtWriter;
    localCheck?: (request: Request, server: BunServer) => boolean;
    launchObsProcess?: (configuredPath?: string) => ObsLaunchResult;
    focusObsProcess?: () => boolean;
  }) {
    this.config = options.config;
    this.store = options.store;
    this.writer = options.writer;
    this.obs = new ObsWebSocketClient(options.config.obs, {
      onLog: (event) => this.addLog(event),
    });
    this.logStore = new PersistentLogStore(join(options.config.exeDir, "events.jsonl"));
    this.launchObsProcess = options.launchObsProcess ?? launchObsProcess;
    this.focusObsProcess = options.focusObsProcess ?? focusObsWindow;
    this.localCheck = options.localCheck ?? isLocalRequest;
    this.addLog({ category: "system", level: "info", message: "Control initialized." });
  }

  start(portOverride?: number): BunServer {
    this.server = Bun.serve({
      port: portOverride ?? this.config.port,
      hostname: this.config.bind,
      fetch: (request, server) => this.handle(request, server),
    });
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), SSE_HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
    this.obs.start();
    this.addLog({ category: "system", level: "success", message: `Server listening on ${this.config.bind}:${this.port}.` });
    return this.server;
  }

  get port(): number {
    return this.server?.port ?? this.config.port;
  }

  snapshot(nowMs = Date.now()): MatchdaySnapshot {
    return this.snapshotFromSession(this.store.load(), nowMs);
  }

  private snapshotFromSession(session: { state: MatchdayState | null; history: MatchdayState[] }, nowMs: number): MatchdaySnapshot {
    return {
      state: session.state,
      undoAvailable: session.history.length > 0,
      clockSeconds: session.state ? currentClockSeconds(session.state, nowMs) : 0,
      serverNowMs: nowMs,
    };
  }

  /**
   * Atualiza o ficheiro do relógio e publica o novo segundo aos browsers.
   * A escrita e o evento SSE usam o mesmo instante, evitando que o painel
   * avance um segundo antes do Clock.txt.
   */
  tickClock(nowMs = Date.now()): void {
    const session = this.store.load();
    if (!session.state) return;
    const previousClock = this.writer.lastValue("clock");
    this.writer.writeState(session.state, nowMs, false);
    const nextClock = this.writer.lastValue("clock");
    if (nextClock !== previousClock) this.broadcast(this.snapshotFromSession(session, nowMs));
  }

  async stop(): Promise<void> {
    this.addLog({ category: "system", level: "info", message: "Server stopping." });
    this.obs.stop();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const controller of [...this.subscribers]) {
      try {
        controller.close();
      } catch {
        // cliente já fechado
      }
    }
    this.subscribers.clear();
    if (this.server) {
      await this.server.stop(true);
      this.server = null;
    }
  }

  /**
   * Aplica um comando internamente (sem autenticação/versão).
   */
  applyCommandAction(action: MatchdayCommandAction): MatchdaySnapshot {
    const session = this.store.load();
    if (!session.state) return this.snapshot();
    const nowMs = Date.now();
    const result = applyCommand(session.state, session.history, action, new Date(nowMs).toISOString());
    if (!result.applied) return this.snapshot();
    this.store.commit(result.state, result.history);
    this.writer.writeState(result.state, nowMs, false);
    this.addLog({ category: "match", level: "info", message: this.describeMatchAction(action, result.state) });
    const snapshot = this.snapshotFromSession({ state: result.state, history: result.history }, nowMs);
    this.broadcast(snapshot);
    return snapshot;
  }

  private obsConfig(): ObsConfig {
    return this.config.obs ?? DEFAULT_OBS_CONFIG;
  }

  private obsSettings(): Record<string, unknown> {
    const config = this.obsConfig();
    return {
      enabled: config.enabled,
      host: config.host,
      port: config.port,
      passwordSet: Boolean(config.password),
      executablePath: config.executablePath ?? "",
      scenes: config.scenes,
      sceneLabels: config.sceneLabels ?? {},
      previewProjector: config.previewProjector ?? DEFAULT_OBS_CONFIG.previewProjector!,
    };
  }

  private updateObsSettings(body: unknown): Record<string, unknown> {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError(400, "Invalid OBS configuration.");
    }
    const source = body as Record<string, unknown>;
    if (source.enabled !== undefined && typeof source.enabled !== "boolean") {
      throw new HttpError(400, "OBS enabled must be a boolean.");
    }
    if (source.host !== undefined && (typeof source.host !== "string" || !source.host.trim())) {
      throw new HttpError(400, "OBS host is required.");
    }
    if (source.port !== undefined && (!Number.isInteger(Number(source.port)) || Number(source.port) < 1 || Number(source.port) > 65535)) {
      throw new HttpError(400, "OBS port is invalid.");
    }
    if (source.password !== undefined && typeof source.password !== "string") {
      throw new HttpError(400, "OBS password is invalid.");
    }
    if (source.executablePath !== undefined && typeof source.executablePath !== "string") {
      throw new HttpError(400, "OBS executable path is invalid.");
    }
    const current = this.obsConfig();
    const projectorPatch = source.previewProjector;
    if (
      projectorPatch !== undefined &&
      (!projectorPatch || typeof projectorPatch !== "object" || Array.isArray(projectorPatch))
    ) {
      throw new HttpError(400, "OBS preview projector settings are invalid.");
    }
    const currentProjector = current.previewProjector ?? DEFAULT_OBS_CONFIG.previewProjector!;
    const projectorSource = projectorPatch as Record<string, unknown> | undefined;
    if (projectorSource?.enabled !== undefined && typeof projectorSource.enabled !== "boolean") {
      throw new HttpError(400, "OBS preview projector enabled must be a boolean.");
    }
    if (
      projectorSource?.monitorIndex !== undefined &&
      (!Number.isInteger(projectorSource.monitorIndex) || Number(projectorSource.monitorIndex) < -1 || Number(projectorSource.monitorIndex) > 1024)
    ) {
      throw new HttpError(400, "OBS preview projector monitorIndex is invalid.");
    }
    if (projectorSource?.autoOpen !== undefined && typeof projectorSource.autoOpen !== "boolean") {
      throw new HttpError(400, "OBS preview projector autoOpen must be a boolean.");
    }
    const previewProjector = {
      enabled: projectorSource?.enabled ?? currentProjector.enabled,
      monitorIndex: projectorSource?.monitorIndex ?? currentProjector.monitorIndex,
      autoOpen: projectorSource?.autoOpen ?? currentProjector.autoOpen,
    };
    const scenePatch = source.scenes;
    if (scenePatch !== undefined && (!scenePatch || typeof scenePatch !== "object" || Array.isArray(scenePatch))) {
      throw new HttpError(400, "OBS scenes are invalid.");
    }
    const sceneLabelsPatch = source.sceneLabels;
    if (
      sceneLabelsPatch !== undefined &&
      (!sceneLabelsPatch || typeof sceneLabelsPatch !== "object" || Array.isArray(sceneLabelsPatch))
    ) {
      throw new HttpError(400, "OBS scene labels are invalid.");
    }
    const scenes = { ...current.scenes, ...(scenePatch as Record<string, unknown> | undefined) };
    const removeSceneKeys = source.removeSceneKeys;
    if (removeSceneKeys !== undefined && (!Array.isArray(removeSceneKeys) || removeSceneKeys.some((key) => typeof key !== "string"))) {
      throw new HttpError(400, "OBS scene removals are invalid.");
    }
    for (const key of (removeSceneKeys as string[] | undefined) ?? []) {
      if (!isValidObsSceneKey(key)) throw new HttpError(400, `The OBS scene '${key}' is invalid.`);
      delete scenes[key];
    }
    for (const [key, value] of Object.entries(scenes)) {
      if (!isValidObsSceneKey(key) || typeof value !== "string" || !value.trim()) {
        throw new HttpError(400, `The OBS scene '${key}' is invalid.`);
      }
    }
    const sceneLabels = { ...(current.sceneLabels ?? {}), ...(sceneLabelsPatch as Record<string, unknown> | undefined) };
    const removeSceneLabelKeys = source.removeSceneLabelKeys;
    if (removeSceneLabelKeys !== undefined && (!Array.isArray(removeSceneLabelKeys) || removeSceneLabelKeys.some((key) => typeof key !== "string"))) {
      throw new HttpError(400, "OBS scene label removals are invalid.");
    }
    for (const key of (removeSceneLabelKeys as string[] | undefined) ?? []) {
      if (!isValidObsSceneKey(key)) throw new HttpError(400, `The OBS scene label '${key}' is invalid.`);
      delete sceneLabels[key];
    }
    for (const [key, value] of Object.entries(sceneLabels)) {
      if (!isValidObsSceneKey(key) || typeof value !== "string" || !value.trim()) {
        throw new HttpError(400, `The OBS scene label '${key}' is invalid.`);
      }
    }
    const next = normalizeObsConfig({
      enabled: source.enabled,
      host: source.host,
      port: source.port,
      executablePath: typeof source.executablePath === "string" ? source.executablePath : current.executablePath,
      // Campo vazio mantém a palavra-passe atual; permite editar o resto sem a expor.
      password: typeof source.password === "string" && source.password.length > 0 ? source.password : current.password,
      scenes,
      sceneLabels,
      previewProjector,
    }, current);
    saveObsConfig(this.config, next);
    this.config.obs = next;
    this.obs.reconfigure(next);
    this.addLog({ category: "obs", level: "info", message: "OBS settings updated." });
    return this.obsSettings();
  }

  private async handle(request: Request, server: BunServer): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/" || path === "/index.html") {
        return htmlResponse(UI_HTML);
      }
      if (path === "/api/auth" && request.method === "POST") {
        return await this.auth(request, server);
      }
      if (path === "/api/state" && request.method === "GET") {
        this.requireAuth(request, url);
        const snapshot = this.snapshot();
        return jsonResponse({ ...snapshot, setupAllowed: this.localCheck(request, server) });
      }
      if (path === "/api/stream" && request.method === "GET") {
        this.requireAuth(request, url);
        return this.streamResponse();
      }
      if (path === "/api/obs/settings" && request.method === "GET") {
        this.requireAuth(request, url);
        return jsonResponse({ settings: this.obsSettings() });
      }
      if (path === "/api/obs/settings" && request.method === "PUT") {
        this.requireAuth(request, url);
        return jsonResponse({ settings: this.updateObsSettings(await jsonObject(request)), obs: this.obs.status() });
      }
      if (path === "/api/obs/test" && request.method === "POST") {
        this.requireAuth(request, url);
        try {
          return jsonResponse({ obs: await this.obs.testConnection() });
        } catch (error) {
          throw new HttpError(503, error instanceof Error ? error.message : "OBS unavailable.", {
            obs: this.obs.status(),
          });
        }
      }
      if (path === "/api/obs/focus" && request.method === "POST") {
        this.requireAuth(request, url);
        const focused = this.focusObsProcess();
        if (!focused) {
          this.addLog({ category: "obs", level: "warning", message: "OBS window could not be brought to the foreground." });
          throw new HttpError(409, "The OBS window was not found. Open OBS first.", { obs: this.obs.status() });
        }
        this.addLog({ category: "obs", level: "success", message: "OBS window brought to the foreground." });
        return jsonResponse({ focused: true, obs: this.obs.status() });
      }
      if (path === "/api/obs/retry" && request.method === "POST") {
        this.requireAuth(request, url);
        try {
          this.obs.start();
          return jsonResponse({ obs: await this.obs.testConnection() });
        } catch (error) {
          throw new HttpError(503, error instanceof Error ? error.message : "OBS unavailable.", {
            obs: this.obs.status(),
          });
        }
      }
      if (path === "/api/obs/launch" && request.method === "POST") {
        this.requireAuth(request, url);
        try {
          const result = this.launchObs();
          this.addLog({
            category: "obs",
            level: result.alreadyRunning ? "info" : "success",
            message: result.alreadyRunning
              ? result.processState === "hidden"
                ? "An OBS process was found without a visible window; no second instance was started."
                : "OBS was already running; connection check requested."
              : `OBS started from ${result.executablePath}.`,
          });
          return jsonResponse({ ...result, obs: this.obs.status() });
        } catch (error) {
          const message = error instanceof Error ? error.message : "OBS could not be started.";
          this.addLog({ category: "obs", level: "error", message: `OBS launch failed: ${message}` });
          throw new HttpError(503, message, { obs: this.obs.status() });
        }
      }
      if (path === "/api/obs/preview-projector" && request.method === "POST") {
        this.requireAuth(request, url);
        try {
          const result = await this.openPreviewProjector();
          return jsonResponse({ ...result, obs: this.obs.status() });
        } catch (error) {
          throw new HttpError(503, error instanceof Error ? error.message : "OBS unavailable.", {
            obs: this.obs.status(),
          });
        }
      }
      if (path === "/api/logs" && request.method === "GET") {
        this.requireAuth(request, url);
        const requestedLimit = Number(url.searchParams.get("limit") ?? 100);
        const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
          ? Math.min(requestedLimit, 1_000)
          : 100;
        const category = url.searchParams.get("category");
        const level = url.searchParams.get("level");
        const query = url.searchParams.get("q")?.trim() || undefined;
        if (category && !isLogCategory(category)) throw new HttpError(400, "Invalid log category.");
        if (level && !isLogLevel(level)) throw new HttpError(400, "Invalid log level.");
        return jsonResponse(this.logStore.list({
          limit,
          category: category as LogCategory | undefined,
          level: level as LogLevel | undefined,
          query,
        }));
      }
      if (path === "/api/logs/export" && request.method === "GET") {
        this.requireAuth(request, url);
        const category = url.searchParams.get("category");
        const level = url.searchParams.get("level");
        const query = url.searchParams.get("q")?.trim() || undefined;
        if (category && !isLogCategory(category)) throw new HttpError(400, "Invalid log category.");
        if (level && !isLogLevel(level)) throw new HttpError(400, "Invalid log level.");
        const date = new Date().toISOString().slice(0, 10);
        return textResponse(
          this.logStore.exportText({
            category: category as LogCategory | undefined,
            level: level as LogLevel | undefined,
            query,
          }),
          {
            "Content-Disposition": `attachment; filename="matchday-events-${date}.log"`,
          },
        );
      }
      if (path === "/api/command" && request.method === "POST") {
        this.requireAuth(request, url);
        const body = await jsonObject(request) as { baseVersion?: unknown; action?: unknown };
        return await this.handleCommand(body);
      }
      if (path === "/api/obs/scene" && request.method === "POST") {
        this.requireAuth(request, url);
        const body = await jsonObject(request) as { sceneKey?: unknown };
        if (
          typeof body.sceneKey !== "string" ||
          !Object.prototype.hasOwnProperty.call(this.obsConfig().scenes, body.sceneKey)
        ) {
          throw new HttpError(400, "Invalid OBS scene.");
        }
        let result: { sceneKey: ObsSceneKey; sceneName: string };
        try {
          result = await this.setObsScene(body.sceneKey as ObsSceneKey);
        } catch (error) {
          throw new HttpError(503, error instanceof Error ? error.message : "OBS unavailable.", {
            obs: this.obs.status(),
          });
        }
        return jsonResponse({ ...result, obs: this.obs.status() });
      }
      if (path === "/api/setup" && request.method === "POST") {
        this.requireAuth(request, url);
        if (!this.localCheck(request, server)) {
          throw new HttpError(403, "Initial setup can only be completed on the host computer (127.0.0.1).");
        }
        const body = await jsonObject(request) as { homeTeam?: unknown; awayTeam?: unknown };
        return jsonResponse(this.handleSetup(body));
      }
      if (path === "/api/health" && request.method === "GET") {
        return jsonResponse(await this.health());
      }
      return jsonResponse({ error: "Not found." }, 404);
    } catch (error) {
      if (error instanceof HttpError) {
        return jsonResponse({ error: error.message, ...error.extra }, error.status);
      }
      if (error instanceof ConflictError) {
        return jsonResponse(
          { error: "The match state changed on another device.", snapshot: this.snapshot() },
          409,
        );
      }
      if (error instanceof SyntaxError) {
        return jsonResponse({ error: "Invalid JSON body." }, 400);
      }
      console.error(`[api] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      return jsonResponse({ error: "Internal error." }, 500);
    }
  }

  private async handleCommand(
    body: { baseVersion?: unknown; action?: unknown },
  ): Promise<Response> {
    const baseVersion = Number(body.baseVersion);
    const action = body.action as MatchdayCommandAction | undefined;
    if (!Number.isInteger(baseVersion) || baseVersion < 1) {
      throw new HttpError(400, "baseVersion is invalid.");
    }
    if (!isMatchdayCommandAction(action)) {
      throw new HttpError(400, "Invalid action.");
    }
    const session = this.store.load();
    if (!session.state) {
      throw new HttpError(404, "No active match. Configure the teams first.");
    }
    if (baseVersion !== session.state.version) {
      throw new HttpError(409, "The match state changed on another device.", { snapshot: this.snapshot() });
    }
    return jsonResponse(this.applyCommandAction(action));
  }

  private handleSetup(body: { homeTeam?: unknown; awayTeam?: unknown }): MatchdaySnapshot {
    const homeTeam = normalizeTeamName(String(body.homeTeam ?? ""));
    const awayTeam = normalizeTeamName(String(body.awayTeam ?? ""));
    if (!homeTeam || !awayTeam) {
      throw new HttpError(422, "Enter both teams.");
    }
    const session = this.store.load();
    const now = new Date().toISOString();
    const nowMs = Date.parse(now);
    let next: ReturnType<typeof applyCommand>;
    if (!session.state) {
      const state = createInitialState(homeTeam, awayTeam, now);
      this.store.commit(state, []);
      this.writer.writeState(state, nowMs, true);
      const snapshot = this.snapshotFromSession({ state, history: [] }, nowMs);
      this.addLog({ category: "match", level: "success", message: `Match configured: ${homeTeam} vs ${awayTeam}.` });
      this.broadcast(snapshot);
      return snapshot;
    } else {
      next = applyCommand(session.state, session.history, { type: "SET_TEAMS", homeTeam, awayTeam }, now);
      if (!next.applied) return this.snapshot();
      this.store.commit(next.state, next.history);
      this.writer.writeState(next.state, nowMs, true);
      const snapshot = this.snapshotFromSession({ state: next.state, history: next.history }, nowMs);
      this.addLog({ category: "match", level: "success", message: `Match configured: ${homeTeam} vs ${awayTeam}.` });
      this.broadcast(snapshot);
      return snapshot;
    }
  }

  async health(): Promise<HealthReport> {
    // OBS WebSocket has no projector-status request. Refresh the Windows
    // window probe before returning health so the UI does not report a
    // projector merely because OBS accepted an earlier request.
    this.obs.refreshProcessState();
    await this.obs.refreshPreviewProjectorState();
    let filesOk = true;
    let lastError: string | null = null;
    try {
      this.writer.probe();
    } catch (error) {
      filesOk = false;
      lastError = `Output directory is not writable (${this.writer.outputDir}): ${error instanceof Error ? error.message : String(error)}`;
    }
    if (this.writer.lastError) {
      filesOk = false;
      lastError = this.writer.lastError;
    }
    const state = this.store.load().state;
    const obs = this.obs.status();
    const serverNowMs = Date.now();
    return {
      checkedAt: new Date(serverNowMs).toISOString(),
      status: filesOk && (!obs.enabled || obs.connected) ? "ok" : "degraded",
      uptime: process.uptime(),
      stateVersion: state?.version ?? null,
      filesOk,
      lastError,
      lastWriteAt: this.writer.lastWriteAt ? new Date(this.writer.lastWriteAt).toISOString() : null,
      obs,
      version: APP_VERSION,
      port: this.port,
      serverNowMs,
    };
  }

  async setObsScene(sceneKey: ObsSceneKey): Promise<{ sceneKey: ObsSceneKey; sceneName: string }> {
    return this.obs.setScene(sceneKey);
  }

  async openPreviewProjector(): Promise<PreviewProjectorResult> {
    const projector = this.obsConfig().previewProjector ?? DEFAULT_OBS_CONFIG.previewProjector!;
    if (!projector.enabled) throw new Error("The OBS preview projector is disabled in the configuration.");
    return this.obs.openPreviewProjector();
  }

  private launchObs(): ObsLaunchResult {
    const config = this.obsConfig();
    if (!config.enabled) throw new Error("OBS integration is disabled in the configuration.");
    const result = this.launchObsProcess(config.executablePath);
    // The background reconnect is normally already active, but starting it
    // here also covers an OBS connection that was reconfigured moments ago.
    this.obs.start();
    return result;
  }

  private addLog(event: AppLogEvent): void {
    this.logStore.add(event);
  }

  private describeMatchAction(action: MatchdayCommandAction, state: MatchdayState): string {
    switch (action.type) {
      case "SCORE":
      case "SET_SCORE":
        return `Score updated: ${state.homeTeam} ${state.homeScore}–${state.awayScore} ${state.awayTeam}.`;
      case "SET_TEAMS":
        return `Teams updated: ${state.homeTeam} vs ${state.awayTeam}.`;
      case "SET_PERIOD":
        return `Period changed to ${state.period}.`;
      case "START_CLOCK":
        return "Match clock started.";
      case "PAUSE_CLOCK":
        return "Match clock paused.";
      case "SET_CLOCK":
        return "Match clock set manually.";
      case "ADJUST_CLOCK":
        return "Match clock adjusted.";
      case "SWITCH_SIDES":
        return "Teams switched sides.";
      case "UNDO":
        return "Last match action undone.";
      case "RESET":
        return "Match reset.";
    }
  }

  private requireAuth(request: Request, url: URL): void {
    const token = bearerToken(request) ?? url.searchParams.get("token");
    if (!token) throw new HttpError(401, "Authentication required.");
    const result = verifyToken(token, this.config.tokenSecret);
    if (!result.ok) {
      throw new HttpError(401, tokenErrorLabel(result));
    }
  }

  private async auth(request: Request, server: BunServer): Promise<Response> {
    const key = requestKey(request, server);
    const now = Date.now();
    for (const [attemptKey, attempt] of this.authAttempts) {
      if (attempt.resetAt <= now && attempt.lockedUntil <= now) this.authAttempts.delete(attemptKey);
    }
    const stored = this.authAttempts.get(key);
    const attempt = stored && stored.resetAt > now ? stored : undefined;
    if (attempt && attempt.lockedUntil > now) {
      const seconds = Math.ceil((attempt.lockedUntil - now) / 1000);
      return jsonResponse({ error: `Too many attempts. Try again in ${seconds}s.` }, 429);
    }
    let pin: unknown;
    try {
      const body = (await request.json()) as { pin?: unknown };
      pin = body.pin;
    } catch {
      return jsonResponse({ error: "Invalid JSON body." }, 400);
    }
    if (typeof pin !== "string" || !verifyAccessPassword(pin, this.config.accessPinHash)) {
      const current = attempt ?? { count: 0, resetAt: now + AUTH_WINDOW_MS, lockedUntil: 0 };
      current.count += 1;
      if (current.count >= MAX_AUTH_ATTEMPTS) {
        current.lockedUntil = now + AUTH_LOCK_MS;
        current.count = 0;
      }
      this.authAttempts.set(key, current);
      return jsonResponse({ error: "Incorrect PIN." }, 401);
    }
    this.authAttempts.delete(key);
    const token = signToken(this.config.tokenSecret, this.config.tokenTtlMs);
    return jsonResponse({ token, expiresAt: now + this.config.tokenTtlMs });
  }

  private streamResponse(): Response {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    return new Response(
      new ReadableStream<Uint8Array>({
        start: (controller) => {
          streamController = controller;
          this.subscribers.add(controller);
          controller.enqueue(
            SSE_ENCODER.encode(`event: state\ndata: ${JSON.stringify(this.snapshot())}\n\n`),
          );
        },
        cancel: () => {
          if (streamController) this.subscribers.delete(streamController);
          streamController = null;
        },
      }),
      {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      },
    );
  }

  private broadcast(snapshot: MatchdaySnapshot): void {
    const payload = SSE_ENCODER.encode(`event: state\ndata: ${JSON.stringify(snapshot)}\n\n`);
    this.sendToSubscribers(payload);
  }

  private sendToSubscribers(payload: Uint8Array): void {
    for (const controller of [...this.subscribers]) {
      try {
        controller.enqueue(payload);
      } catch {
        this.subscribers.delete(controller);
      }
    }
  }

  private sendHeartbeat(): void {
    this.sendToSubscribers(SSE_ENCODER.encode(": ping\n\n"));
  }

}

function isLocalRequest(request: Request, server: BunServer): boolean {
  const ip = server.requestIP(request)?.address;
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function requestKey(request: Request, server: BunServer): string {
  return server.requestIP(request)?.address ?? "unknown";
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization?.toLowerCase().startsWith("bearer ")) return null;
  const token = authorization.slice(7).trim();
  return token || null;
}

function tokenErrorLabel(result: TokenVerification): string {
  if (result.ok) return "Invalid session.";
  return result.reason === "expired" ? "Session expired. Sign in again with the PIN." : "Invalid session.";
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function textResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      ...headers,
    },
  });
}

async function jsonObject(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "The JSON body must be an object.");
  }
  return body as Record<string, unknown>;
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
  });
}
