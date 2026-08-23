import type { Server } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInitialState, normalizeTeamName, type MatchdayState } from "./domain/matchday";
import { applyCommand, isMatchdayCommandAction, type MatchdayCommandAction } from "./commands";
import { verifyAccessPassword, verifyToken, signToken, type TokenVerification } from "./auth";
import { MatchdayStore, ConflictError } from "./store";
import { TxtWriter } from "./writer";
import { DEFAULT_OBS_CONFIG, normalizeObsConfig, saveObsConfig, type AppConfig, type ObsConfig } from "./config";
import { OBS_SCENE_KEYS, ObsWebSocketClient, type ObsSceneKey } from "./obs";
import embeddedUi from "./ui/index.html";

export const APP_VERSION = "1.5.0";

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
}

export interface HealthReport {
  status: "ok" | "degraded";
  uptime: number;
  stateVersion: number | null;
  filesOk: boolean;
  lastError: string | null;
  lastWriteAt: string | null;
  obs: ReturnType<ObsWebSocketClient["status"]>;
  version: string;
  port: number;
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
  private readonly localCheck: (request: Request, server: BunServer) => boolean;
  private readonly subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private readonly authAttempts = new Map<string, AuthAttempt>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private server: BunServer | null = null;

  constructor(options: {
    config: AppConfig;
    store: MatchdayStore;
    writer: TxtWriter;
    localCheck?: (request: Request, server: BunServer) => boolean;
  }) {
    this.config = options.config;
    this.store = options.store;
    this.writer = options.writer;
    this.obs = new ObsWebSocketClient(options.config.obs);
    this.localCheck = options.localCheck ?? isLocalRequest;
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
    return this.server;
  }

  get port(): number {
    return this.server?.port ?? this.config.port;
  }

  snapshot(): MatchdaySnapshot {
    const session = this.store.load();
    return {
      state: session.state,
      undoAvailable: session.history.length > 0,
    };
  }

  async stop(): Promise<void> {
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
    const result = applyCommand(session.state, session.history, action);
    if (!result.applied) return this.snapshot();
    this.store.commit(result.state, result.history);
    this.writer.writeState(result.state, Date.now(), false);
    const snapshot = this.snapshot();
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
      scenes: config.scenes,
    };
  }

  private updateObsSettings(body: unknown): Record<string, unknown> {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError(400, "Configuração OBS inválida.");
    }
    const source = body as Record<string, unknown>;
    if (source.enabled !== undefined && typeof source.enabled !== "boolean") {
      throw new HttpError(400, "O estado OBS deve ser booleano.");
    }
    if (source.host !== undefined && (typeof source.host !== "string" || !source.host.trim())) {
      throw new HttpError(400, "O host OBS é obrigatório.");
    }
    if (source.port !== undefined && (!Number.isInteger(Number(source.port)) || Number(source.port) < 1 || Number(source.port) > 65535)) {
      throw new HttpError(400, "A porta OBS é inválida.");
    }
    if (source.password !== undefined && typeof source.password !== "string") {
      throw new HttpError(400, "A palavra-passe OBS é inválida.");
    }
    const current = this.obsConfig();
    const scenePatch = source.scenes;
    if (scenePatch !== undefined && (!scenePatch || typeof scenePatch !== "object" || Array.isArray(scenePatch))) {
      throw new HttpError(400, "As cenas OBS são inválidas.");
    }
    const scenes = { ...current.scenes, ...(scenePatch as Record<string, unknown> | undefined) };
    for (const key of OBS_SCENE_KEYS) {
      if (typeof scenes[key] !== "string" || !scenes[key].trim()) {
        throw new HttpError(400, `O nome da cena ${key} é obrigatório.`);
      }
    }
    const next = normalizeObsConfig({
      enabled: source.enabled,
      host: source.host,
      port: source.port,
      // Campo vazio mantém a palavra-passe atual; permite editar o resto sem a expor.
      password: typeof source.password === "string" && source.password.length > 0 ? source.password : current.password,
      scenes,
    }, current);
    saveObsConfig(this.config, next);
    this.config.obs = next;
    this.obs.reconfigure(next);
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
          throw new HttpError(503, error instanceof Error ? error.message : "OBS indisponível.", {
            obs: this.obs.status(),
          });
        }
      }
      if (path === "/api/command" && request.method === "POST") {
        this.requireAuth(request, url);
        const body = await jsonObject(request) as { baseVersion?: unknown; action?: unknown };
        return await this.handleCommand(body);
      }
      if (path === "/api/obs/scene" && request.method === "POST") {
        this.requireAuth(request, url);
        const body = await jsonObject(request) as { sceneKey?: unknown };
        if (typeof body.sceneKey !== "string" || !OBS_SCENE_KEYS.includes(body.sceneKey as ObsSceneKey)) {
          throw new HttpError(400, "Cena OBS inválida.");
        }
        let result: { sceneKey: ObsSceneKey; sceneName: string };
        try {
          result = await this.setObsScene(body.sceneKey as ObsSceneKey);
        } catch (error) {
          throw new HttpError(503, error instanceof Error ? error.message : "OBS indisponível.", {
            obs: this.obs.status(),
          });
        }
        return jsonResponse({ ...result, obs: this.obs.status() });
      }
      if (path === "/api/setup" && request.method === "POST") {
        this.requireAuth(request, url);
        if (!this.localCheck(request, server)) {
          throw new HttpError(403, "A configuração inicial só pode ser feita no computador anfitrião (127.0.0.1).");
        }
        const body = await jsonObject(request) as { homeTeam?: unknown; awayTeam?: unknown };
        return jsonResponse(this.handleSetup(body));
      }
      if (path === "/api/health" && request.method === "GET") {
        return jsonResponse(this.health());
      }
      return jsonResponse({ error: "Não encontrado." }, 404);
    } catch (error) {
      if (error instanceof HttpError) {
        return jsonResponse({ error: error.message, ...error.extra }, error.status);
      }
      if (error instanceof ConflictError) {
        return jsonResponse(
          { error: "O estado do jogo mudou noutro dispositivo.", snapshot: this.snapshot() },
          409,
        );
      }
      if (error instanceof SyntaxError) {
        return jsonResponse({ error: "Corpo JSON inválido." }, 400);
      }
      console.error(`[api] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      return jsonResponse({ error: "Erro interno." }, 500);
    }
  }

  private async handleCommand(
    body: { baseVersion?: unknown; action?: unknown },
  ): Promise<Response> {
    const baseVersion = Number(body.baseVersion);
    const action = body.action as MatchdayCommandAction | undefined;
    if (!Number.isInteger(baseVersion) || baseVersion < 1) {
      throw new HttpError(400, "baseVersion inválido.");
    }
    if (!isMatchdayCommandAction(action)) {
      throw new HttpError(400, "Ação inválida.");
    }
    const session = this.store.load();
    if (!session.state) {
      throw new HttpError(404, "Sem controlo ativo. Configure as equipas primeiro.");
    }
    if (baseVersion !== session.state.version) {
      throw new HttpError(409, "O estado do jogo mudou noutro dispositivo.", { snapshot: this.snapshot() });
    }
    return jsonResponse(this.applyCommandAction(action));
  }

  private handleSetup(body: { homeTeam?: unknown; awayTeam?: unknown }): MatchdaySnapshot {
    const homeTeam = normalizeTeamName(String(body.homeTeam ?? ""));
    const awayTeam = normalizeTeamName(String(body.awayTeam ?? ""));
    if (!homeTeam || !awayTeam) {
      throw new HttpError(422, "Indica as duas equipas.");
    }
    const session = this.store.load();
    const now = new Date().toISOString();
    let next: ReturnType<typeof applyCommand>;
    if (!session.state) {
      const state = createInitialState(homeTeam, awayTeam, now);
      this.store.commit(state, []);
      this.writer.writeState(state, Date.now(), true);
    } else {
      next = applyCommand(session.state, session.history, { type: "SET_TEAMS", homeTeam, awayTeam }, now);
      if (!next.applied) return this.snapshot();
      this.store.commit(next.state, next.history);
      this.writer.writeState(next.state, Date.now(), true);
    }
    const snapshot = this.snapshot();
    this.broadcast(snapshot);
    return snapshot;
  }

  health(): HealthReport {
    let filesOk = true;
    let lastError: string | null = null;
    try {
      this.writer.probe();
    } catch (error) {
      filesOk = false;
      lastError = `Diretoria de saída não escrevível (${this.writer.outputDir}): ${error instanceof Error ? error.message : String(error)}`;
    }
    if (this.writer.lastError) {
      filesOk = false;
      lastError = this.writer.lastError;
    }
    const state = this.store.load().state;
    return {
      status: filesOk ? "ok" : "degraded",
      uptime: process.uptime(),
      stateVersion: state?.version ?? null,
      filesOk,
      lastError,
      lastWriteAt: this.writer.lastWriteAt ? new Date(this.writer.lastWriteAt).toISOString() : null,
      obs: this.obs.status(),
      version: APP_VERSION,
      port: this.port,
    };
  }

  async setObsScene(sceneKey: ObsSceneKey): Promise<{ sceneKey: ObsSceneKey; sceneName: string }> {
    return this.obs.setScene(sceneKey);
  }

  private requireAuth(request: Request, url: URL): void {
    const token = bearerToken(request) ?? url.searchParams.get("token");
    if (!token) throw new HttpError(401, "Autenticação necessária.");
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
      return jsonResponse({ error: `Demasiadas tentativas. Tenta de novo em ${seconds}s.` }, 429);
    }
    let pin: unknown;
    try {
      const body = (await request.json()) as { pin?: unknown };
      pin = body.pin;
    } catch {
      return jsonResponse({ error: "Corpo JSON inválido." }, 400);
    }
    if (typeof pin !== "string" || !verifyAccessPassword(pin, this.config.accessPinHash)) {
      const current = attempt ?? { count: 0, resetAt: now + AUTH_WINDOW_MS, lockedUntil: 0 };
      current.count += 1;
      if (current.count >= MAX_AUTH_ATTEMPTS) {
        current.lockedUntil = now + AUTH_LOCK_MS;
        current.count = 0;
      }
      this.authAttempts.set(key, current);
      return jsonResponse({ error: "Palavra-passe incorreta." }, 401);
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
  if (result.ok) return "Sessão inválida.";
  return result.reason === "expired" ? "Sessão expirada. Entra de novo com o PIN." : "Sessão inválida.";
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function jsonObject(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "O corpo JSON deve ser um objeto.");
  }
  return body as Record<string, unknown>;
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
  });
}
