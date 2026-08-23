import assert from "node:assert/strict";
import test from "node:test";
import { FIXED_ACCESS_PASSWORD, randomTokenSecret, signToken, verifyAccessPassword, verifyToken } from "../src/auth";

test("palavra-passe operacional fixa", () => {
  assert.equal(FIXED_ACCESS_PASSWORD, "1887");
  assert.equal(verifyAccessPassword("1887"), true);
  assert.equal(verifyAccessPassword("123456"), false);
  assert.equal(verifyAccessPassword("1887 "), false);
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
