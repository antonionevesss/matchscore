import assert from "node:assert/strict";
import test from "node:test";
import { ObsWebSocketClient } from "../src/obs";

interface SentMessage {
  op: number;
  d: Record<string, unknown>;
}

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readyState = 0;
  sent: SentMessage[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onmessage?.({ data: JSON.stringify({ op: 0, d: { rpcVersion: 1 } }) });
    });
  }

  send(value: string): void {
    const message = JSON.parse(value) as SentMessage;
    this.sent.push(message);
    if (message.op === 1) {
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ op: 2, d: {} }) }));
    }
    if (message.op === 6) {
      const responseData = message.d.requestType === "GetCurrentProgramScene"
        ? { sceneName: "Marcador" }
        : undefined;
      queueMicrotask(() => this.onmessage?.({
        data: JSON.stringify({
          op: 7,
          d: {
            requestId: message.d.requestId,
            requestStatus: { result: true },
            ...(responseData ? { responseData } : {}),
          },
        }),
      }));
    }
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

test("cliente OBS autentica, liga e troca a cena", async () => {
  const original = globalThis.WebSocket;
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket as unknown as typeof WebSocket,
  });
  try {
    const client = new ObsWebSocketClient({
      enabled: true,
      host: "127.0.0.1",
      port: 4455,
      password: "obs-secret",
      scenes: {
        matchscore: "Marcador",
        goal: "Alerta de golo",
        sponsors: "Patrocinadores",
        music: "Música inicial",
      },
      sceneLabels: { music: "Música inicial" },
      previewProjector: { enabled: true, monitorIndex: 1, autoOpen: false },
    }, { detectPreviewProjectors: async () => 0 });
    client.start();
    await client.testConnection();
    assert.equal(client.status().currentSceneName, "Marcador");
    const result = await client.setScene("goal");
    assert.deepEqual(result, { sceneKey: "goal", sceneName: "Alerta de golo" });
    assert.equal(client.status().connected, true);
    const socket = FakeWebSocket.instances.at(-1)!;
    assert.equal(socket.url, "ws://127.0.0.1:4455");
    assert.equal(socket.sent.some((message) => message.op === 1), true);
    const sceneRequest = socket.sent.find((message) => message.d.requestType === "SetCurrentProgramScene");
    assert.equal(sceneRequest?.d.requestType, "SetCurrentProgramScene");
    assert.deepEqual(sceneRequest?.d.requestData, { sceneName: "Alerta de golo" });
    const music = await client.setScene("music");
    assert.deepEqual(music, { sceneKey: "music", sceneName: "Música inicial" });
    const musicRequest = socket.sent.filter((message) => message.op === 6).at(-1);
    assert.equal(musicRequest?.d.requestType, "SetCurrentProgramScene");
    assert.deepEqual(musicRequest?.d.requestData, { sceneName: "Música inicial" });
    const projector = await client.openPreviewProjector();
    assert.deepEqual(projector, { monitorIndex: 1, alreadyOpen: false });
    assert.equal(client.status().previewProjectorOpen, null);
    const projectorRequest = socket.sent.filter((message) => message.op === 6).at(-1);
    assert.equal(projectorRequest?.d.requestType, "OpenVideoMixProjector");
    assert.deepEqual(projectorRequest?.d.requestData, {
      videoMixType: "OBS_WEBSOCKET_VIDEO_MIX_TYPE_PREVIEW",
      monitorIndex: 1,
    });
    const duplicate = await client.openPreviewProjector();
    assert.deepEqual(duplicate, { monitorIndex: 1, alreadyOpen: true });
    assert.equal(socket.sent.filter((message) => message.d.requestType === "OpenVideoMixProjector").length, 1);
    client.stop();
  } finally {
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: original });
  }
});

test("cliente OBS abre o projetor automaticamente ao ligar", async () => {
  const original = globalThis.WebSocket;
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket as unknown as typeof WebSocket,
  });
  try {
    const client = new ObsWebSocketClient({
      enabled: true,
      host: "127.0.0.1",
      port: 4455,
      password: "",
      scenes: { matchscore: "Marcador" },
      previewProjector: { enabled: true, monitorIndex: 1, autoOpen: true },
    }, { detectPreviewProjectors: async () => 0 });
    client.start();
    await client.testConnection();
    await Bun.sleep(10);
    const socket = FakeWebSocket.instances.at(-1)!;
    assert.equal(client.status().previewProjectorOpen, null);
    assert.equal(socket.sent.some((message) => message.d.requestType === "OpenVideoMixProjector"), true);
    assert.equal(socket.sent.filter((message) => message.d.requestType === "OpenVideoMixProjector").length, 1);
    client.stop();
  } finally {
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: original });
  }
});

test("cliente OBS não envia outro pedido quando já existe uma janela confirmada", async () => {
  const original = globalThis.WebSocket;
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket as unknown as typeof WebSocket,
  });
  try {
    const client = new ObsWebSocketClient({
      enabled: true,
      host: "127.0.0.1",
      port: 4455,
      password: "",
      scenes: { matchscore: "Marcador" },
      previewProjector: { enabled: true, monitorIndex: 1, autoOpen: false },
    }, { detectPreviewProjectors: async () => 1 });
    client.start();
    await client.testConnection();
    const result = await client.openPreviewProjector();
    const socket = FakeWebSocket.instances.at(-1)!;
    assert.deepEqual(result, { monitorIndex: 1, alreadyOpen: true });
    assert.equal(client.status().previewProjectorOpen, true);
    assert.equal(socket.sent.filter((message) => message.d.requestType === "OpenVideoMixProjector").length, 0);
    client.stop();
  } finally {
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: original });
  }
});

test("cliente OBS desativado não tenta ligar", async () => {
  const client = new ObsWebSocketClient();
  assert.equal(client.status().enabled, false);
  assert.equal(client.status().previewProjectorOpen, null);
  await assert.rejects(() => client.setScene("matchscore"), /disabled/);
  client.stop();
});
