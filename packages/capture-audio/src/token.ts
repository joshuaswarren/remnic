/**
 * Bearer-token lifecycle. The daemon auto-generates a 256-bit token on
 * first use and stores it 0600; a pre-existing file is re-chmod'd 0600
 * defensively because a world-readable token is a credential leak. The
 * token is REQUIRED on every request when the daemon binds a non-loopback
 * host (see daemon.ts); on loopback it exists but localhost is trusted.
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
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  return token;
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
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match ? match[1].trim() : null;
}
