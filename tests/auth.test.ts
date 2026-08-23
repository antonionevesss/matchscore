import assert from "node:assert/strict";
import test from "node:test";
import { FIXED_ACCESS_PASSWORD, hashPin, randomTokenSecret, signToken, verifyAccessPassword, verifyPin, verifyToken } from "../src/auth";

test("palavra-passe operacional fixa", () => {
  assert.equal(FIXED_ACCESS_PASSWORD, "1887");
  assert.equal(verifyAccessPassword("1887"), true);
  assert.equal(verifyAccessPassword("123456"), false);
  assert.equal(verifyAccessPassword("1887 "), false);
});

test("hash e verificação de PIN", () => {
  const hash = hashPin("123456");
  assert.equal(verifyPin("123456", hash), true);
  assert.equal(verifyPin("654321", hash), false);
  assert.equal(verifyPin("123456", null), false);
  assert.equal(verifyPin("123456", "garbage"), false);
});

test("tokens assinados verificam e expiram", () => {
  const secret = randomTokenSecret();
  const token = signToken(secret, 60_000, 1_000_000);
  assert.deepEqual(verifyToken(token, secret, 1_000_000), { ok: true });
  assert.equal(verifyToken(token, secret, 1_100_000).ok, false);
  assert.equal(verifyToken(token, randomTokenSecret(), 1_000_000).ok, false);
  assert.equal(verifyToken("abc.def", secret, 1_000_000).ok, false);
  assert.equal(verifyToken("", secret, 1_000_000).ok, false);
});
