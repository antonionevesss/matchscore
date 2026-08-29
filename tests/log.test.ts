import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PersistentLogStore } from "../src/log";

test("eventos estruturados persistem, filtram e recuperam IDs depois de reiniciar", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-log-"));
  const path = join(dir, "events.jsonl");
  try {
    const first = new PersistentLogStore(path, 10);
    first.add({ category: "system", level: "info", message: "Server ready" }, "2026-08-29T10:00:00.000Z");
    first.add({ category: "obs", level: "error", message: "OBS connection failed" }, "2026-08-29T10:01:00.000Z");
    first.add({ category: "match", level: "success", message: "Goal scored" }, "2026-08-29T10:02:00.000Z");

    assert.equal(first.list({ category: "obs" }).total, 1);
    assert.equal(first.list({ level: "success" }).logs[0]?.message, "Goal scored");
    assert.equal(first.list({ query: "connection" }).logs[0]?.message, "OBS connection failed");
    assert.match(first.exportText({ category: "obs" }), /OBS connection failed/);
    assert.equal(readFileSync(path, "utf8").trim().split(/\r?\n/).length, 3);

    const second = new PersistentLogStore(path, 10);
    const next = second.add({ category: "system", level: "warning", message: "Recovered" }, "2026-08-29T10:03:00.000Z");
    assert.equal(next.id, 4);
    assert.equal(second.list({ limit: 2 }).logs[0]?.message, "Recovered");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
