import assert from "node:assert/strict";
import test from "node:test";
import { keepSystemAwake } from "../src/power";

test("pedido de energia pode ser criado e libertado", () => {
  const request = keepSystemAwake();
  assert.equal(typeof request.release, "function");
  request.release();
  request.release();
});
