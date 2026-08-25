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
      queueMicrotask(() => this.onmessage?.({
        data: JSON.stringify({
          op: 7,
          d: {
            requestId: message.d.requestId,
            requestStatus: { result: true },
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
    });
    client.start();
    const result = await client.setScene("goal");
  assert.deepEqual(result, { sceneKey: "goal", sceneName: "Alerta de golo" });
    assert.equal(client.status().connected, true);
    const socket = FakeWebSocket.instances.at(-1)!;
    assert.equal(socket.url, "ws://127.0.0.1:4455");
    assert.equal(socket.sent.some((message) => message.op === 1), true);
    const sceneRequest = socket.sent.find((message) => message.op === 6);
    assert.equal(sceneRequest?.d.requestType, "SetCurrentProgramScene");
    assert.deepEqual(sceneRequest?.d.requestData, { sceneName: "Alerta de golo" });
    const music = await client.setScene("music");
    assert.deepEqual(music, { sceneKey: "music", sceneName: "Música inicial" });
    const musicRequest = socket.sent.filter((message) => message.op === 6).at(-1);
    assert.equal(musicRequest?.d.requestType, "SetCurrentProgramScene");
    assert.deepEqual(musicRequest?.d.requestData, { sceneName: "Música inicial" });
    client.stop();
  } finally {
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: original });
  }
});

test("cliente OBS desativado não tenta ligar", async () => {
  const client = new ObsWebSocketClient();
  assert.equal(client.status().enabled, false);
  await assert.rejects(() => client.setScene("matchscore"), /disabled/);
  client.stop();
});
