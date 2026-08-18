/**
 * OAuth2 user-token store with single-owner refresh for the X MCP
 * source.
 *
 * X rotates the refresh token on EVERY refresh. Two independent
 * refreshers fork the chain and kill one of them (observed failure:
 * HTTP 401 on refresh after two tools both rotated the same grant).
 * This store is therefore the single owner of the refresh chain: the
 * refresh runs only while holding `${tokenFile}.lock`; a concurrent
 * refresher waits, then adopts the rotated pair from the file — it
 * never refreshes in parallel.
 *
 * Token files are written 0600, atomic (tmp + rename), and unknown
 * top-level fields are preserved on rotation.
 */

import { open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleepMs } from "node:timers/promises";

import { isXObject } from "./guards.js";

export const X_TOKEN_REFRESH_URL = "https://api.x.com/2/oauth2/token";
const EXPIRY_MARGIN_MS = 60_000;
const DEFAULT_LOCK_STALE_MS = 60_000;
const DEFAULT_LOCK_WAIT_MS = 15_000;
const LOCK_POLL_MS = 200;

export class XTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XTokenError";
  }
}

/** The refresh chain forked or was revoked — re-authorization is required. */
export class XRefreshChainBrokenError extends XTokenError {
  constructor(detail: string) {
    super(
      `X OAuth2 refresh failed (${detail}). The refresh chain was rotated by another refresher or the grant was revoked. Ensure only one refresher owns the chain, then re-authorize to write a fresh token file.`
    );
    this.name = "XRefreshChainBrokenError";
  }
}

export interface XTokenPair {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
}

export interface XTokenStoreOptions {
  tokenFile: string;
  clientId: string;
  clientSecret: string;
  /** OAuth2 token endpoint. */
  refreshUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  lockStaleMs?: number;
  lockWaitMs?: number;
}

interface LockHandle {
  release(): Promise<void>;
}

class LockUnavailableError extends Error {}

export class XTokenStore {
  private readonly tokenFile: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly refreshUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly lockStaleMs: number;
  private readonly lockWaitMs: number;
  private cached: XTokenPair | null = null;

  constructor(options: XTokenStoreOptions) {
    if (typeof options.tokenFile !== "string" || options.tokenFile.length === 0) {
      throw new XTokenError("XTokenStore requires tokenFile");
    }
    for (const [field, value] of [
      ["clientId", options.clientId],
      ["clientSecret", options.clientSecret],
    ] as const) {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new XTokenError(
          `XTokenStore requires ${field} (pre-registered confidential client; set xConnector source auth or the REMNIC_X_CLIENT_ID/REMNIC_X_CLIENT_SECRET env vars)`
        );
      }
    }
    this.tokenFile = options.tokenFile;
    this.clientId = options.clientId.trim();
    this.clientSecret = options.clientSecret.trim();
    this.refreshUrl = options.refreshUrl ?? X_TOKEN_REFRESH_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
    this.lockWaitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
    this.sleep = options.sleep ?? sleepMs;
  }

  /** Returns a valid access token, refreshing under the lock when expired. */
  async getAccessToken(): Promise<string> {
    return (await this.getValidPair()).accessToken;
  }

  private async getValidPair(): Promise<XTokenPair> {
    const current = this.cached ?? (await this.readTokenFile());
    if (current !== null && current.expiresAt - EXPIRY_MARGIN_MS > this.now()) {
      this.cached = current;
      return current;
    }
    const refreshed = await this.refreshWithLock();
    this.cached = refreshed;
    return refreshed;
  }

  /**
   * Refreshes the token pair under the file lock. When another owner
   * holds the lock, waits for it, then adopts the pair it wrote.
   */
  async refresh(): Promise<XTokenPair> {
    const pair = await this.refreshWithLock();
    this.cached = pair;
    return pair;
  }

  private async refreshWithLock(): Promise<XTokenPair> {
    let lock: LockHandle | null = null;
    try {
      lock = await this.acquireLock();
    } catch (err) {
      if (err instanceof LockUnavailableError) {
        return this.waitForOtherOwner();
      }
      throw err;
    }
    try {
      // Re-read under the lock: another owner may have rotated while we waited.
      const underLock = await this.readTokenFile();
      if (underLock !== null && underLock.expiresAt - EXPIRY_MARGIN_MS > this.now()) {
        return underLock;
      }
      const refreshToken =
        underLock?.refreshToken ??
        (() => {
          throw new XTokenError(
            `X token file ${this.tokenFile} is missing or carries no refresh_token — run the OAuth2 user-code flow once to seed it`
          );
        })();
      const rotated = await this.requestRefresh(refreshToken);
      await this.writeTokenFile(rotated);
      return rotated;
    } finally {
      await lock.release();
    }
  }

  private async waitForOtherOwner(): Promise<XTokenPair> {
    const deadline = this.now() + this.lockWaitMs;
    while (this.now() < deadline) {
      await this.sleep(LOCK_POLL_MS);
      const pair = await this.readTokenFile();
      if (pair !== null && pair.expiresAt - EXPIRY_MARGIN_MS > this.now()) {
        return pair;
      }
    }
    throw new XTokenError(
      `another refresher has held ${this.tokenFile}.lock for over ` +
        `${Math.round(this.lockWaitMs / 1000)}s — investigate the competing owner`
    );
  }

  private async acquireLock(): Promise<LockHandle> {
    const lockPath = `${this.tokenFile}.lock`;
    const deadline = this.now() + this.lockWaitMs;
    for (;;) {
      try {
        const handle = await open(lockPath, "wx");
        await handle.write(`${process.pid}\n`);
        await handle.close();
        return {
          release: async () => {
            try {
              await unlink(lockPath);
            } catch {
              // Already gone — nothing to release.
            }
          },
        };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw err;
        if (await this.stealStaleLock(lockPath)) continue;
        if (this.now() >= deadline) throw new LockUnavailableError("lock wait timeout");
        await this.sleep(LOCK_POLL_MS);
      }
    }
  }

  /** Steals the lock when its mtime is older than lockStaleMs. */
  private async stealStaleLock(lockPath: string): Promise<boolean> {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(lockPath)).mtimeMs;
    } catch {
      // Lock vanished between open(EEXIST) and stat — retry create.
      return true;
    }
    if (this.now() - mtimeMs < this.lockStaleMs) return false;
    try {
      await unlink(lockPath);
    } catch {
      // Another stealer won the race — the next create attempt decides.
    }
    return true;
  }

  private async requestRefresh(refreshToken: string): Promise<XTokenPair> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.clientId,
    }).toString();
    let response: Response;
    try {
      response = await this.fetchImpl(this.refreshUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`,
        },
        body,
      });
    } catch (err) {
      throw new XTokenError(`X OAuth2 refresh request failed: ${err instanceof Error ? err.name : "network error"}`);
    }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new XRefreshChainBrokenError(`HTTP ${response.status}`);
    }
    if (!response.ok) {
      throw new XTokenError(`X OAuth2 refresh responded HTTP ${response.status}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new XTokenError("X OAuth2 refresh returned a non-JSON body");
    }
    if (!isTokenResponse(payload)) {
      throw new XTokenError("X OAuth2 refresh returned an unexpected payload shape");
    }
    return {
      accessToken: payload.access_token,
      // X rotates refresh tokens; keep the old one when the response omits it.
      refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : refreshToken,
      expiresAt: this.now() + payload.expires_in * 1_000,
    };
  }

  private async readTokenFile(): Promise<XTokenPair | null> {
    let raw: string;
    try {
      raw = await readFile(this.tokenFile, "utf8");
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new XTokenError(`X token file ${this.tokenFile} is not valid JSON`);
    }
    if (!isXObject(parsed)) return null;
    const accessToken = firstString(parsed.access_token, parsed.accessToken);
    if (accessToken === undefined) {
      throw new XTokenError(`X token file ${this.tokenFile} carries no access token`);
    }
    const refreshToken = firstString(parsed.refresh_token, parsed.refreshToken) ?? "";
    const expiresAtRaw = parsed.expires_at ?? parsed.expiresAt;
    const expiresAt =
      typeof expiresAtRaw === "number" && Number.isFinite(expiresAtRaw)
        ? expiresAtRaw
        : // Files without expiry force one refresh on first use.
          0;
    return { accessToken, refreshToken, expiresAt };
  }

  /** Atomic 0600 write; preserves unknown top-level fields from the prior file. */
  private async writeTokenFile(pair: XTokenPair): Promise<void> {
    let previous: Record<string, unknown> = {};
    try {
      const priorRaw: unknown = JSON.parse(await readFile(this.tokenFile, "utf8"));
      if (isXObject(priorRaw)) previous = priorRaw;
    } catch {
      previous = {};
    }
    const next: Record<string, unknown> = {
      ...previous,
      access_token: pair.accessToken,
      refresh_token: pair.refreshToken,
      expires_at: pair.expiresAt,
    };
    const dir = path.dirname(this.tokenFile);
    const tmpPath = path.join(dir, `.${path.basename(this.tokenFile)}.${process.pid}.${Date.now()}.tmp`);
    await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    try {
      await rename(tmpPath, this.tokenFile);
    } catch (err) {
      try {
        await unlink(tmpPath);
      } catch {
        // Best-effort cleanup.
      }
      throw new XTokenError(
        `failed to persist rotated X tokens to ${this.tokenFile}: ${err instanceof Error ? err.name : "write error"}`
      );
    }
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function isTokenResponse(value: unknown): value is {
  access_token: string;
  refresh_token?: unknown;
  expires_in: number;
} {
  return isXObject(value) && typeof value.access_token === "string";
}
