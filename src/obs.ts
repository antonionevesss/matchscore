import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_OBS_CONFIG, normalizeObsConfig, type ObsConfig } from "./config";
import type { AppLogEvent } from "./log";
import { detectObsProcessState, detectObsProcessStateAsync, type ObsProcessState } from "./obs-launcher";
import { detectObsPreviewProjectors } from "./windows-projector";

export type ObsSceneKey = string;
export interface PreviewProjectorResult {
  monitorIndex: number;
  alreadyOpen: boolean;
}

export interface ObsWebSocketClientOptions {
  /** Hook kept injectable so the OBS protocol tests do not depend on a desktop. */
  detectPreviewProjectors?: () => Promise<number | null>;
  detectObsProcessState?: () => ObsProcessState;
  detectObsProcessStateAsync?: () => Promise<ObsProcessState>;
  onLog?: (event: AppLogEvent) => void;
}

export interface ObsStatus {
  enabled: boolean;
  connected: boolean;
  host: string;
  port: number;
  passwordSet: boolean;
  scenes: ObsConfig["scenes"];
  sceneLabels: NonNullable<ObsConfig["sceneLabels"]>;
  previewProjector: NonNullable<ObsConfig["previewProjector"]>;
  /** True/false after Windows confirms the visible projector window; null is unknown. */
  previewProjectorOpen: boolean | null;
  /** Number of visible OBS preview projector windows in the last probe. */
  previewProjectorCount: number | null;
  /** When the Windows projector probe last completed. */
  previewProjectorLastCheckedAt: string | null;
  currentSceneName: string | null;
  lastError: string | null;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  reconnecting: boolean;
  reconnectAttempt: number;
  processState: ObsProcessState;
  processLastCheckedAt: string | null;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ObsMessage {
  op?: number;
  d?: {
    rpcVersion?: number;
    authentication?: { salt?: string; challenge?: string };
    requestId?: string;
    requestStatus?: { result?: boolean; comment?: string };
    responseData?: { sceneName?: string; currentProgramSceneName?: string };
    eventType?: string;
    eventData?: { sceneName?: string };
  };
}

const REQUEST_TIMEOUT_MS = 5_000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function sha256Base64(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64");
}

function obsAuthentication(password: string, salt: string, challenge: string): string {
  const secret = sha256Base64(password + salt);
  return sha256Base64(secret + challenge);
}

export function isLocalObsHost(host: string): boolean {
  const normalized = String(host || "").trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "::ffff:127.0.0.1"
  );
}

export class ObsWebSocketClient {
  private config: ObsConfig;
  private socket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private stopped = false;
  private identified = false;
  private autoProjectorAttempted = false;
  private previewProjectorRequested = false;
  private previewProjectorOpen: boolean | null = null;
  private previewProjectorCount: number | null = null;
  private previewProjectorLastCheckedAt: string | null = null;
  private previewProjectorOpening: Promise<PreviewProjectorResult> | null = null;
  private lastPreviewProjectorRequestAt = 0;
  private currentSceneName: string | null = null;
  private lastError: string | null = null;
  private lastConnectedAt: string | null = null;
  private lastDisconnectedAt: string | null = null;
  private processState: ObsProcessState = "unknown";
  private processLastCheckedAt: string | null = null;
  private lastProcessCheckAt = 0;
  private lastProjectorCheckAt = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly detectProjectors: () => Promise<number | null>;
  private readonly detectProcess: () => ObsProcessState;
  private readonly detectProcessAsync: () => Promise<ObsProcessState>;
  private readonly onLog: (event: AppLogEvent) => void;
  private processRefresh: Promise<ObsProcessState> | null = null;

  constructor(config?: ObsConfig, options: ObsWebSocketClientOptions = {}) {
    this.config = normalizeObsConfig(config ?? DEFAULT_OBS_CONFIG);
    this.detectProjectors = options.detectPreviewProjectors ?? detectObsPreviewProjectors;
    this.detectProcess = options.detectObsProcessState ?? detectObsProcessState;
    this.detectProcessAsync = options.detectObsProcessStateAsync ?? (() => detectObsProcessStateAsync());
    this.onLog = options.onLog ?? (() => {});
  }

  reconfigure(config: ObsConfig): void {
    this.config = normalizeObsConfig(config);
    this.currentSceneName = null;
    this.previewProjectorRequested = false;
    this.previewProjectorOpen = null;
    this.previewProjectorCount = null;
    this.previewProjectorLastCheckedAt = null;
    this.lastPreviewProjectorRequestAt = 0;
    this.lastError = null;
    this.processState = "unknown";
    this.processLastCheckedAt = null;
    this.autoProjectorAttempted = false;
    this.stop();
    this.start();
  }

  start(): void {
    this.stopped = false;
    if (this.config.enabled) void this.connectInBackground();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.rejectPending(new Error("OBS connection stopped."));
    const socket = this.socket;
    this.socket = null;
    this.identified = false;
    this.autoProjectorAttempted = false;
    this.previewProjectorRequested = false;
    this.previewProjectorOpen = null;
    this.previewProjectorCount = null;
    this.previewProjectorLastCheckedAt = null;
    this.previewProjectorOpening = null;
    this.lastPreviewProjectorRequestAt = 0;
    this.currentSceneName = null;
    if (socket) socket.close();
  }

  status(): ObsStatus {
    return {
      enabled: this.config.enabled,
      connected: this.identified && this.socket?.readyState === WebSocket.OPEN,
      host: this.config.host,
      port: this.config.port,
      passwordSet: Boolean(this.config.password),
      scenes: this.config.scenes,
      sceneLabels: this.config.sceneLabels ?? {},
      previewProjector: this.config.previewProjector ?? DEFAULT_OBS_CONFIG.previewProjector!,
      previewProjectorOpen: this.previewProjectorOpen,
      previewProjectorCount: this.previewProjectorCount,
      previewProjectorLastCheckedAt: this.previewProjectorLastCheckedAt,
      currentSceneName: this.currentSceneName,
      lastError: this.lastError,
      lastConnectedAt: this.lastConnectedAt,
      lastDisconnectedAt: this.lastDisconnectedAt,
      reconnecting: Boolean(this.connecting || this.reconnectTimer),
      reconnectAttempt: this.reconnectAttempt,
      processState: this.processState,
      processLastCheckedAt: this.processLastCheckedAt,
    };
  }

  refreshProcessState(): ObsProcessState {
    if (!this.config.enabled) {
      this.processState = "unknown";
      this.processLastCheckedAt = new Date().toISOString();
      return this.processState;
    }
    if (!isLocalObsHost(this.config.host)) {
      this.processState = this.identified ? "visible" : "unknown";
      this.processLastCheckedAt = new Date().toISOString();
      return this.processState;
    }
    const now = Date.now();
    if (this.processState !== "unknown" && now - this.lastProcessCheckAt < 3_000) {
      return this.processState;
    }
    this.lastProcessCheckAt = now;
    try {
      this.processState = this.detectProcess();
    } catch {
      this.processState = "unknown";
    }
    this.processLastCheckedAt = new Date().toISOString();
    return this.processState;
  }

  /**
   * Non-blocking process probe used by the periodic health endpoint.
   * Uses fast in-memory FFI with TTL cache.
   */
  async refreshProcessStateAsync(): Promise<ObsProcessState> {
    if (!this.config.enabled) {
      this.processState = "unknown";
      this.processLastCheckedAt = new Date().toISOString();
      return this.processState;
    }
    if (!isLocalObsHost(this.config.host)) {
      this.processState = this.identified ? "visible" : "unknown";
      this.processLastCheckedAt = new Date().toISOString();
      return this.processState;
    }
    const now = Date.now();
    if (this.processState !== "unknown" && now - this.lastProcessCheckAt < 3_000) {
      return this.processState;
    }
    if (this.processRefresh) return this.processRefresh;

    const refresh = (async (): Promise<ObsProcessState> => {
      this.lastProcessCheckAt = Date.now();
      try {
        this.processState = await this.detectProcessAsync();
      } catch {
        this.processState = "unknown";
      }
      this.processLastCheckedAt = new Date().toISOString();
      return this.processState;
    })();
    this.processRefresh = refresh;
    try {
      return await refresh;
    } finally {
      if (this.processRefresh === refresh) this.processRefresh = null;
    }
  }

  async setScene(key: ObsSceneKey): Promise<{ sceneKey: ObsSceneKey; sceneName: string }> {
    if (!Object.prototype.hasOwnProperty.call(this.config.scenes, key)) throw new Error("Invalid OBS scene.");
    if (!this.config.enabled) throw new Error("OBS integration is disabled in the configuration.");

    try {
      await this.connect();
      const sceneName = this.config.scenes[key];
      await this.request("SetCurrentProgramScene", { sceneName });
      this.currentSceneName = sceneName;
      this.lastError = null;
      this.log("obs", "info", `Active scene set to ${sceneName}.`);
      return { sceneKey: key, sceneName };
    } catch (error) {
      this.lastError = asError(error).message;
      throw error;
    }
  }

  async testConnection(): Promise<ObsStatus> {
    if (!this.config.enabled) throw new Error("OBS integration is disabled in the configuration.");
    try {
      await this.connect();
      await this.request("GetVersion", {});
      this.lastError = null;
      return this.status();
    } catch (error) {
      this.lastError = asError(error).message;
      throw error;
    }
  }

  async openPreviewProjector(): Promise<PreviewProjectorResult> {
    if (!this.config.enabled) throw new Error("OBS integration is disabled in the configuration.");
    const projector = this.config.previewProjector ?? DEFAULT_OBS_CONFIG.previewProjector!;
    if (!projector.enabled) throw new Error("The OBS preview projector is disabled in the configuration.");
    if (this.previewProjectorOpening) {
      const result = await this.previewProjectorOpening;
      return { ...result, alreadyOpen: true };
    }

    const opening = this.openPreviewProjectorOnce(projector.monitorIndex);
    this.previewProjectorOpening = opening;
    try {
      return await opening;
    } finally {
      if (this.previewProjectorOpening === opening) this.previewProjectorOpening = null;
    }
  }

  /**
   * Refreshes the best available projector state. OBS WebSocket has no
   * projector-list/status request, so Windows window enumeration is the
   * authoritative check when it is available on local host.
   */
  async refreshPreviewProjectorState(): Promise<boolean | null> {
    const projector = this.config.previewProjector ?? DEFAULT_OBS_CONFIG.previewProjector!;
    if (!this.config.enabled || !projector.enabled) {
      this.previewProjectorRequested = false;
      this.previewProjectorOpen = null;
      this.lastPreviewProjectorRequestAt = 0;
      return null;
    }

    if (!isLocalObsHost(this.config.host)) {
      if (this.previewProjectorRequested && this.identified) {
        this.previewProjectorOpen = true;
        this.previewProjectorLastCheckedAt = new Date().toISOString();
        return true;
      }
      this.previewProjectorOpen = null;
      this.previewProjectorLastCheckedAt = new Date().toISOString();
      return null;
    }

    const now = Date.now();
    if (this.previewProjectorOpen !== null && now - this.lastProjectorCheckAt < 3_000) {
      return this.previewProjectorOpen;
    }
    this.lastProjectorCheckAt = now;

    let count: number | null;
    try {
      count = await this.detectProjectors();
    } catch (error) {
      this.previewProjectorCount = null;
      this.previewProjectorLastCheckedAt = new Date().toISOString();
      this.previewProjectorOpen = null;
      this.lastError = `Projector check failed: ${asError(error).message}`;
      this.log("projector", "warning", this.lastError);
      return null;
    }
    this.previewProjectorCount = count;
    this.previewProjectorLastCheckedAt = new Date().toISOString();
    if (count === null) {
      this.previewProjectorOpen = null;
      return null;
    }
    if (count > 0) {
      this.previewProjectorRequested = true;
      this.setDetectedProjectorState(true);
      return true;
    }

    if (this.previewProjectorOpening || Date.now() - this.lastPreviewProjectorRequestAt < 3_000) {
      this.previewProjectorOpen = null;
      return null;
    }
    this.previewProjectorRequested = false;
    this.setDetectedProjectorState(false);
    this.lastPreviewProjectorRequestAt = 0;
    return false;
  }


  private async connectInBackground(): Promise<void> {
    try {
      await this.connect();
    } catch {
      // A reconexão agendada mantém o erro disponível no estado de saúde.
    }
  }

  private connect(): Promise<void> {
    if (this.identified && this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<void>((resolve, reject) => {
      let settled = false;
      let socket: WebSocket;
      try {
        socket = new WebSocket(`ws://${this.config.host}:${this.config.port}`);
      } catch (error) {
        this.lastError = asError(error).message;
        reject(error);
        return;
      }

      this.socket = socket;
      this.identified = false;
      this.currentSceneName = null;
      this.previewProjectorOpen = null;
      this.previewProjectorCount = null;

      const fail = (error: unknown): void => {
        const reason = asError(error);
        this.lastError = reason.message;
        this.identified = false;
        this.lastDisconnectedAt = new Date().toISOString();
        if (this.reconnectAttempt === 0) {
          this.log("obs", "error", `OBS connection failed: ${reason.message}`);
        }
        if (!settled) {
          settled = true;
          reject(reason);
        }
        this.scheduleReconnect();
      };

      socket.onmessage = (event) => {
        let message: ObsMessage;
        try {
          message = JSON.parse(String(event.data)) as ObsMessage;
        } catch {
          fail(new Error("Invalid OBS WebSocket response."));
          return;
        }

        const data = message.d ?? {};
        if (message.op === 0) {
          const authentication = data.authentication;
          const identify: Record<string, unknown> = {
            rpcVersion: data.rpcVersion ?? 1,
          };
          if (authentication?.salt && authentication.challenge) {
            identify.authentication = obsAuthentication(
              this.config.password,
              authentication.salt,
              authentication.challenge,
            );
          }
          socket.send(JSON.stringify({ op: 1, d: identify }));
          return;
        }

        if (message.op === 2) {
          this.identified = true;
          this.lastError = null;
          this.lastConnectedAt = new Date().toISOString();
          this.reconnectAttempt = 0;
          this.log("obs", "success", "OBS WebSocket connected.");
          void this.syncCurrentScene()
            .catch(() => {
              // A scene sync failure must not make the OBS connection unusable.
            })
            .finally(() => {
              if (!settled) {
                settled = true;
                resolve();
              }
              if (this.socket === socket && this.identified) this.maybeOpenPreviewProjector();
            });
          return;
        }

        if (message.op === 5 && data.eventType === "ExitStarted") {
          this.autoProjectorAttempted = false;
          this.previewProjectorRequested = false;
          this.previewProjectorOpen = null;
          this.lastPreviewProjectorRequestAt = 0;
          this.currentSceneName = null;
          this.log("obs", "warning", "OBS is shutting down.");
          return;
        }

        if (message.op === 5 && data.eventType === "CurrentProgramSceneChanged") {
          this.currentSceneName = data.eventData?.sceneName ?? null;
          if (this.currentSceneName) this.log("obs", "info", `Active scene changed to ${this.currentSceneName}.`);
          return;
        }

        if (message.op === 7 && data.requestId) {
          const pending = this.pending.get(data.requestId);
          if (!pending) return;
          this.pending.delete(data.requestId);
          clearTimeout(pending.timer);
          if (data.requestStatus?.result === true) pending.resolve(data);
          else pending.reject(new Error(data.requestStatus?.comment || "OBS rejected the request."));
        }
      };

      socket.onerror = () => fail(new Error("Could not connect to the OBS WebSocket."));
      socket.onclose = () => {
        this.socket = null;
        const wasIdentified = this.identified;
        this.identified = false;
        this.lastDisconnectedAt = new Date().toISOString();
        this.previewProjectorOpen = null;
        this.previewProjectorCount = null;
        this.previewProjectorOpening = null;
        this.currentSceneName = null;
        if (wasIdentified && !this.stopped) this.log("obs", "warning", "OBS WebSocket connection closed.");
        if (!settled) {
          settled = true;
          reject(new Error(this.lastError || "The OBS connection was closed."));
        }
        this.rejectPending(new Error("The OBS connection was closed."));
        this.scheduleReconnect();
      };
    }).finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  private request(requestType: string, requestData: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket;
    if (!socket || !this.identified || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("OBS is not connected."));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("OBS communication timed out."));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({
          op: 6,
          d: { requestType, requestId, requestData },
        }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  private async syncCurrentScene(): Promise<void> {
    const response = await this.request("GetCurrentProgramScene", {}) as {
      responseData?: { sceneName?: unknown; currentProgramSceneName?: unknown };
    };
    const sceneName = response.responseData?.sceneName ?? response.responseData?.currentProgramSceneName;
    if (typeof sceneName === "string") {
      this.currentSceneName = sceneName;
      this.log("obs", "info", `Active scene: ${sceneName}.`);
    }
    this.lastError = null;
  }

  private async requestPreviewProjector(monitorIndex: number): Promise<PreviewProjectorResult> {
    try {
      await this.connect();
      await this.request("OpenVideoMixProjector", {
        videoMixType: "OBS_WEBSOCKET_VIDEO_MIX_TYPE_PREVIEW",
        monitorIndex,
      });
      this.previewProjectorRequested = true;
      this.previewProjectorOpen = null;
      this.lastPreviewProjectorRequestAt = Date.now();
      this.autoProjectorAttempted = true;
      this.lastError = null;
      this.log("projector", "info", "OBS accepted the preview projector request; checking the window.");
      return { monitorIndex, alreadyOpen: false };
    } catch (error) {
      this.previewProjectorRequested = false;
      this.previewProjectorOpen = null;
      this.lastPreviewProjectorRequestAt = 0;
      this.lastError = asError(error).message;
      this.log("projector", "error", `Preview projector request failed: ${this.lastError}`);
      throw error;
    }
  }

  private async openPreviewProjectorOnce(monitorIndex: number): Promise<PreviewProjectorResult> {
    await this.refreshPreviewProjectorState();
    if (this.previewProjectorOpen === true || (this.previewProjectorRequested && this.previewProjectorOpen === null)) {
      return { monitorIndex, alreadyOpen: true };
    }
    return this.requestPreviewProjector(monitorIndex);
  }

  private setDetectedProjectorState(state: boolean): void {
    const changed = this.previewProjectorOpen !== state;
    this.previewProjectorOpen = state;
    if (!changed) return;
    if (state) this.log("projector", "success", "Preview projector window confirmed by Windows.");
    else this.log("projector", "warning", "Preview projector window not detected.");
  }

  private log(category: AppLogEvent["category"], level: AppLogEvent["level"], message: string): void {
    try {
      this.onLog({ category, level, message });
    } catch {
      // Logging must never affect OBS control.
    }
  }

  private rejectPending(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(requestId);
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.config.enabled || this.reconnectTimer) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectInBackground();
    }, delay);
  }

  private maybeOpenPreviewProjector(): void {
    const projector = this.config.previewProjector;
    if (!projector?.enabled || !projector.autoOpen || this.autoProjectorAttempted) return;
    this.autoProjectorAttempted = true;
    void this.openPreviewProjector().catch((error) => {
      this.lastError = `Preview projector: ${asError(error).message}`;
    });
  }
}
