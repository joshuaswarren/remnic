/**
 * Token management for Remnic multi-connector auth.
 *
 * Manages per-connector tokens in ~/.remnic/tokens.json.
 * Each connector gets a unique token with a recognizable prefix.
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { resolveHomeDir } from "./runtime/env.js";

export interface TokenEntry {
  token: string;
  connector: string;
  createdAt: string;
}

export interface TokenStore {
  tokens: TokenEntry[];
}

const TOKEN_PREFIXES: Record<string, string> = {
  "openclaw": "remnic_oc_",
  "claude-code": "remnic_cc_",
  "codex-cli": "remnic_cx_",
  "codex": "remnic_cx_",
  "hermes": "remnic_hm_",
  "pi": "remnic_pi_",
  "replit": "remnic_rl_",
  "cursor": "remnic_cu_",
  "cline": "remnic_cl_",
  "github-copilot": "remnic_gh_",
  "roo-code": "remnic_rc_",
  "windsurf": "remnic_ws_",
  "amp": "remnic_am_",
  "generic-mcp": "remnic_gm_",
};

function defaultTokensPath(): string {
  return path.join(resolveHomeDir(), ".remnic", "tokens.json");
}

function legacyTokensPath(): string {
  return path.join(resolveHomeDir(), ".engram", "tokens.json");
}

function resolveReadPath(tokensPath?: string): string {
  const primary = tokensPath ?? defaultTokensPath();
  if (tokensPath) return primary;
  if (fs.existsSync(primary)) return primary;
  const legacy = legacyTokensPath();
  return fs.existsSync(legacy) ? legacy : primary;
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function validateTokenEntry(raw: unknown, index: number): TokenEntry {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`invalid token entry at index ${index}: expected object`);
  }
  const entry = raw as Record<string, unknown>;
  if (typeof entry.token !== "string" || entry.token.length === 0) {
    throw new Error(`invalid token entry at index ${index}: token must be a non-empty string`);
  }
  if (typeof entry.connector !== "string" || entry.connector.length === 0) {
    throw new Error(`invalid token entry at index ${index}: connector must be a non-empty string`);
  }
  return {
    token: entry.token,
    connector: entry.connector,
    createdAt:
      typeof entry.createdAt === "string" && entry.createdAt.length > 0
        ? entry.createdAt
        : new Date(0).toISOString(),
  };
}

function parseTokenStore(rawText: string, filePath: string): { store: TokenStore; migratedLegacy: boolean } {
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch (error) {
    throw new Error(
      `failed to parse token store at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    if (record.tokens !== undefined) {
      if (!Array.isArray(record.tokens)) {
        throw new Error(`invalid token store at ${filePath}: tokens must be an array`);
      }
      return {
        store: {
          tokens: record.tokens.map((entry, index) => validateTokenEntry(entry, index)),
        },
        migratedLegacy: false,
      };
    }

    // Migrate legacy flat-map format: { "connector": "token_value", ... }
    const migrated: TokenEntry[] = [];
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === "string" && value.length > 0) {
        migrated.push(
          validateTokenEntry(
            { token: value, connector: key, createdAt: new Date().toISOString() },
            migrated.length,
          ),
        );
      }
    }
    if (migrated.length > 0) {
      return { store: { tokens: migrated }, migratedLegacy: true };
    }
  }

  throw new Error(`invalid token store at ${filePath}: expected token array or legacy connector map`);
}

export function loadTokenStore(tokensPath?: string): TokenStore {
  const p = resolveReadPath(tokensPath);
  try {
    const rawText = fs.readFileSync(p, "utf8");
    const { store, migratedLegacy } = parseTokenStore(rawText, p);
    if (migratedLegacy) {
      // Auto-migrate legacy flat-map stores in new format. This is best-effort:
      // a migration write failure must not hide the successfully parsed tokens.
      try {
        saveTokenStore(store, tokensPath);
      } catch {
        // Migration write failed (e.g., read-only fs) — still return parsed tokens.
      }
    }
    return store;
  } catch (error) {
    if (isEnoent(error)) {
      return { tokens: [] };
    }
    throw error;
  }
}

function fsyncDirectoryBestEffort(dirPath: string): void {
  let dirFd: number | null = null;
  try {
    dirFd = fs.openSync(dirPath, "r");
    fs.fsyncSync(dirFd);
  } catch {
    // Directory fsync is not supported on every platform/filesystem.
  } finally {
    if (dirFd !== null) {
      try { fs.closeSync(dirFd); } catch { /* ignore */ }
    }
  }
}

export function saveTokenStore(store: TokenStore, tokensPath?: string): void {
  const p = tokensPath ?? defaultTokensPath();
  ensureDir(p);
  const validated: TokenStore = {
    tokens: store.tokens.map((entry, index) => validateTokenEntry(entry, index)),
  };
  const dir = path.dirname(p);
  const tmpPath = path.join(dir, `.${path.basename(p)}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmpPath, "w", 0o600);
    fs.writeFileSync(fd, JSON.stringify(validated, null, 2) + "\n", "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, p);
    // Tighten permissions on pre-existing files after atomic replacement.
    try { fs.chmodSync(p, 0o600); } catch { /* ignore on platforms without chmod */ }
    fsyncDirectoryBestEffort(dir);
    invalidateTokenCache();
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore cleanup failure */ }
    throw error;
  }
}

/**
 * Build a TokenEntry candidate WITHOUT saving it to the store.
 * Callers use this when they need to defer the save until after a
 * dependent write (e.g. Hermes config.yaml) succeeds — see
 * commitTokenEntry() to persist the candidate.
 */
export function buildTokenEntry(connector: string): TokenEntry {
  const prefix = TOKEN_PREFIXES[connector] ?? "remnic_xx_";
  const token = prefix + randomBytes(24).toString("hex");
  return {
    token,
    connector,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Persist a pre-built TokenEntry into the store, replacing any existing
 * entry for the same connector. Used together with buildTokenEntry() when
 * the caller wants to defer the save until after a dependent write succeeds.
 *
 * For transactional rollback, callers should snapshot the full store via
 * loadTokenStore() BEFORE calling commitTokenEntry() and restore it with
 * saveTokenStore() on failure. A full-store snapshot handles partial writes
 * of tokens.json atomically — single-entry restore via the return value is
 * insufficient because if this function throws during saveTokenStore, the
 * return statement never executes (UXJI/UXJT fix).
 */
export function commitTokenEntry(entry: TokenEntry, tokensPath?: string): void {
  const store = loadTokenStore(tokensPath);
  store.tokens = store.tokens.filter((t) => t.connector !== entry.connector);
  store.tokens.push(entry);
  saveTokenStore(store, tokensPath);
}

export function generateToken(connector: string, tokensPath?: string): TokenEntry {
  const store = loadTokenStore(tokensPath);

  // Remove existing token for this connector
  store.tokens = store.tokens.filter((t) => t.connector !== connector);

  const entry = buildTokenEntry(connector);
  store.tokens.push(entry);
  saveTokenStore(store, tokensPath);
  return entry;
}

export function listTokens(tokensPath?: string): TokenEntry[] {
  return loadTokenStore(tokensPath).tokens;
}

export function revokeToken(connector: string, tokensPath?: string): boolean {
  const store = loadTokenStore(tokensPath);
  const before = store.tokens.length;
  store.tokens = store.tokens.filter((t) => t.connector !== connector);
  if (store.tokens.length < before) {
    saveTokenStore(store, tokensPath);
    return true;
  }
  return false;
}

export function getAllValidTokens(tokensPath?: string): string[] {
  return loadTokenStore(tokensPath).tokens.map((t) => t.token);
}

// Cached token loader to avoid synchronous disk I/O on every HTTP request.
// Re-reads tokens.json at most once per TTL interval (default 5s).
const TOKEN_CACHE_TTL_MS = 5_000;
let _cachedTokens: string[] = [];
let _cachedAt = 0;
let _cachedPath: string | undefined;

function invalidateTokenCache(): void {
  _cachedTokens = [];
  _cachedAt = 0;
  _cachedPath = undefined;
}

export function getAllValidTokensCached(tokensPath?: string): string[] {
  const now = Date.now();
  if (now - _cachedAt < TOKEN_CACHE_TTL_MS && tokensPath === _cachedPath) return _cachedTokens;
  _cachedTokens = getAllValidTokens(tokensPath);
  _cachedAt = now;
  _cachedPath = tokensPath;
  return _cachedTokens;
}

export function resolveConnectorFromToken(token: string, tokensPath?: string): string | undefined {
  return loadTokenStore(tokensPath).tokens.find((t) => t.token === token)?.connector;
}
