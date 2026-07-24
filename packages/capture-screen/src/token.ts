/**
 * Bearer-token lifecycle. The daemon auto-generates a 256-bit token on first
 * use and stores it 0600; a pre-existing file is re-chmod'd 0600 defensively
 * because a world-readable token is a credential leak. The token is REQUIRED on
 * every request (even on loopback) so another local user cannot read captured
 * screen text off 127.0.0.1.
 */

import { Buffer } from "node:buffer";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function loadOrCreateToken(tokenPath: string): string {
  mkdirSync(path.dirname(tokenPath), { recursive: true });
  if (existsSync(tokenPath)) {
    chmodSync(tokenPath, 0o600);
    const existing = readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  }
  const token = generateToken();
  try {
    // Exclusive create: if two daemons start together, the loser gets EEXIST and
    // reads the winner's token rather than both persisting divergent values.
    writeFileSync(tokenPath, `${token}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(tokenPath, 0o600);
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    chmodSync(tokenPath, 0o600);
    const raced = readFileSync(tokenPath, "utf8").trim();
    if (raced) return raced;
    // Pre-existing empty file (interrupted prior write): overwrite it.
    writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
    return token;
  }
}

/** Constant-time compare; unequal lengths short-circuit to false. */
export function tokensMatch(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Parse `Authorization: Bearer <token>`; returns null when absent/malformed. */
export function bearerFromHeader(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.slice(0, 6).toLowerCase() !== "bearer") return null;
  const separator = trimmed.charCodeAt(6);
  if (separator !== 32 && separator !== 9) return null;
  const token = trimmed.slice(6).trim();
  return token || null;
}
