import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const ACCESS_PIN_PREFIX = "scrypt";

/** Gera um PIN numérico para a primeira instalação. */
export function randomAccessPin(): string {
  const value = randomBytes(4).readUInt32BE(0) % 900_000;
  return String(value + 100_000);
}

/** Guarda o PIN sem o expor no ficheiro de configuração. */
export function hashAccessPassword(value: string): string {
  const salt = randomBytes(16).toString("hex");
  const digest = scryptSync(String(value), salt, 32).toString("hex");
  return `${ACCESS_PIN_PREFIX}$${salt}$${digest}`;
}

export function isValidAccessPin(value: string): boolean {
  return /^\d{6}$/.test(value);
}

export function verifyAccessPassword(value: string, storedHash: string): boolean {
  try {
    const [prefix, salt, digest] = String(storedHash).split("$");
    if (prefix !== ACCESS_PIN_PREFIX || !salt || !digest || !/^[0-9a-f]{64}$/i.test(digest)) return false;
    const expected = Buffer.from(digest, "hex");
    const candidate = scryptSync(String(value ?? ""), salt, expected.length);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

export function randomTokenSecret(): string {
  return randomBytes(32).toString("hex");
}

export interface TokenPayload {
  exp: number;
  iat: number;
}

function encodePart(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodePart(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

export function signToken(secret: string, ttlMs: number, nowMs = Date.now()): string {
  const payload: TokenPayload = { exp: nowMs + ttlMs, iat: nowMs };
  const body = encodePart(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  return `${body}.${signature}`;
}

export type TokenVerification =
  | { ok: true }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" };

export function verifyToken(token: string, secret: string, nowMs = Date.now()): TokenVerification {
  const separator = token.lastIndexOf(".");
  if (separator <= 0 || separator === token.length - 1) return { ok: false, reason: "malformed" };
  const body = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad-signature" };
  try {
    const payload = JSON.parse(decodePart(body)) as Partial<TokenPayload>;
    if (typeof payload.exp !== "number" || payload.exp <= nowMs) return { ok: false, reason: "expired" };
  } catch {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true };
}
