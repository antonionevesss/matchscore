import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Palavra-passe operacional fixa do Matchday Control. */
export const FIXED_ACCESS_PASSWORD = "1887";

export function verifyAccessPassword(value: string): boolean {
  const candidate = Buffer.from(String(value ?? ""), "utf8");
  const expected = Buffer.from(FIXED_ACCESS_PASSWORD, "utf8");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
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
