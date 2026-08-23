import assert from "node:assert/strict";
import test from "node:test";
import { hashAccessPassword, randomTokenSecret, signToken, verifyAccessPassword, verifyToken } from "../src/auth";

test("PIN operacional é validado contra um hash", () => {
  const hash = hashAccessPassword("246810");
  assert.equal(verifyAccessPassword("246810", hash), true);
  assert.equal(verifyAccessPassword("123456", hash), false);
  assert.equal(verifyAccessPassword("246810 ", hash), false);
  assert.equal(verifyAccessPassword("246810", "hash inválido"), false);
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
