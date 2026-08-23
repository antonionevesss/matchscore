import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_OBS_CONFIG, type ObsConfig } from "./config";

export const OBS_SCENE_KEYS = ["matchscore", "goal", "sponsors"] as const;
export type ObsSceneKey = (typeof OBS_SCENE_KEYS)[number];

export interface ObsStatus {
  enabled: boolean;
  connected: boolean;
  host: string;
  port: number;
  passwordSet: boolean;
  scenes: ObsConfig["scenes"];
  currentSceneName: string | null;
  lastError: string | null;
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

export class ObsWebSocketClient {
  private config: ObsConfig;
  private socket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private stopped = false;
  private identified = false;
  private currentSceneName: string | null = null;
  private lastError: string | null = null;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(config?: ObsConfig) {
    this.config = config ?? DEFAULT_OBS_CONFIG;
  }

  reconfigure(config: ObsConfig): void {
    this.config = config;
    this.currentSceneName = null;
    this.lastError = null;
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
    this.rejectPending(new Error("Ligação OBS terminada."));
    const socket = this.socket;
    this.socket = null;
    this.identified = false;
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
      currentSceneName: this.currentSceneName,
      lastError: this.lastError,
    };
  }

  async setScene(key: ObsSceneKey): Promise<{ sceneKey: ObsSceneKey; sceneName: string }> {
    if (!OBS_SCENE_KEYS.includes(key)) throw new Error("Cena OBS inválida.");
    if (!this.config.enabled) throw new Error("A ligação OBS está desativada na configuração.");

    try {
      await this.connect();
      const sceneName = this.config.scenes[key];
      await this.request("SetCurrentProgramScene", { sceneName });
      this.currentSceneName = sceneName;
      this.lastError = null;
      return { sceneKey: key, sceneName };
    } catch (error) {
      this.lastError = asError(error).message;
      throw error;
    }
  }

  async testConnection(): Promise<ObsStatus> {
    if (!this.config.enabled) throw new Error("A ligação OBS está desativada na configuração.");
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

      const fail = (error: unknown): void => {
        const reason = asError(error);
        this.lastError = reason.message;
        this.identified = false;
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
          fail(new Error("Resposta inválida do OBS WebSocket."));
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
          this.reconnectAttempt = 0;
          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }

        if (message.op === 5 && data.eventType === "CurrentProgramSceneChanged") {
          this.currentSceneName = data.eventData?.sceneName ?? null;
          return;
        }

        if (message.op === 7 && data.requestId) {
          const pending = this.pending.get(data.requestId);
          if (!pending) return;
          this.pending.delete(data.requestId);
          clearTimeout(pending.timer);
          if (data.requestStatus?.result === true) pending.resolve(data);
          else pending.reject(new Error(data.requestStatus?.comment || "O OBS rejeitou o pedido."));
        }
      };

      socket.onerror = () => fail(new Error("Não foi possível ligar ao OBS WebSocket."));
      socket.onclose = () => {
        this.socket = null;
        this.identified = false;
        if (!settled) {
          settled = true;
          reject(new Error(this.lastError || "A ligação OBS foi encerrada."));
        }
        this.rejectPending(new Error("A ligação OBS foi encerrada."));
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
      return Promise.reject(new Error("OBS não está ligado."));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Tempo esgotado ao comunicar com o OBS."));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify({
        op: 6,
        d: { requestType, requestId, requestData },
      }));
    });
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
}
