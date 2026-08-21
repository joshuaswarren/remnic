/**
 * Mem0 MemCorrect adapter (issue #1727 — highest-priority third-party adapter).
 *
 * Drives Mem0 through its public REST API so MemCorrect can score Mem0 on the
 * same correction/steerability corpus as the Remnic adapter. This is the
 * single highest-leverage missing comparison piece: Mem0 is the most-cited
 * memory system, and "we beat Mem0 on non-resurrection" is unsubstantiable
 * without this adapter.
 *
 * Two deployment modes are supported:
 *
 *   - **OSS self-hosted** (`mode: "oss"`): synchronous REST server (FastAPI).
 *     Paths have no `/v1/` prefix: `POST /memories`, `POST /search`,
 *     `DELETE /memories?user_id=…`. Operators self-host for reproducible
 *     benchmarking — they control the deployment, the LLM, and there is no
 *     rate limiting. This is the recommended mode for lab runs.
 *
 *   - **Hosted platform** (`mode: "hosted"`): `api.mem0.ai` with the V3
 *     async pipeline. `POST /v3/memories/add/` returns an `event_id` that is
 *     polled until `SUCCEEDED`. Search uses `POST /v3/memories/search/`.
 *
 * The adapter accepts an injectable `fetch` so the deterministic fixture
 * smoke test exercises the full request/response cycle without a network.
 * No keys are embedded; without operator-provided credentials every method
 * throws `MissingCredentialError` (skip-with-reason — no keys in CI).
 */

import type { MemCorrectSystemAdapter } from "../types.js";
import {
  delay,
  httpJson,
  isNotFoundDelete,
  requireCredentials,
  resetTrackedIds,
  resolveFetch,
  uniqueRunSuffix,
  type FetchLike,
  type ThirdPartyAdapterConfig,
} from "./shared.js";

export interface Mem0AdapterConfig extends ThirdPartyAdapterConfig {
  /**
   * Deployment mode.
   * - `"oss"` — self-hosted synchronous server (recommended for lab runs).
   * - `"hosted"` — api.mem0.ai V3 async pipeline.
   *
   * Defaults to `"oss"` when a custom `baseUrl` is set, `"hosted"` otherwise.
   */
  mode?: "oss" | "hosted";
  /** Prefix prepended to sessionKeys to namespace Mem0 user_ids. */
  userIdPrefix?: string;
  /**
   * OSS authentication header mode.
   * - "x-api-key" (default): send the API key as X-API-Key. Mem0's self-hosted
   *   REST auth uses X-API-Key for per-user/API keys (m0sk_…, ADMIN_API_KEY);
   *   Authorization: Bearer is reserved for dashboard JWTs
   *   (https://docs.mem0.ai/open-source/features/rest-api#authentication).
   * - "bearer": send Authorization: Bearer for operators who deploy JWT auth.
   */
  ossAuthMode?: "x-api-key" | "bearer";
  /** Hosted-mode: interval between event-status polls (ms). */
  pollIntervalMs?: number;
  /** Hosted-mode: maximum poll attempts before timing out. */
  maxPolls?: number;
}

/** A single extracted memory returned by Mem0 search. */
interface Mem0SearchResult {
  memory?: string;
  id?: string;
}

/** Event-status response for hosted async add. */
interface Mem0EventStatus {
  status?: string;
  event_id?: string;
  error?: string;
}

/**
 * MemCorrect adapter for Mem0. Construct with operator-provided credentials;
 * pass a `fetch` override for deterministic testing.
 *
 * @example
 * // Lab run (operator provides keys):
 * const adapter = new Mem0MemCorrectAdapter({
 *   mode: "oss",
 *   baseUrl: process.env.MEM0_BASE_URL,
 *   apiKey: process.env.MEM0_API_KEY,
 * });
 *
 * @example
 * // Keyless — every method throws MissingCredentialError (skip-with-reason):
 * const adapter = new Mem0MemCorrectAdapter({});
 */
export class Mem0MemCorrectAdapter implements MemCorrectSystemAdapter {
  readonly label: string;
  private readonly mode: "oss" | "hosted";
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly userIdPrefix: string;
  private readonly ossAuthMode: "x-api-key" | "bearer";
  private readonly pollIntervalMs: number;
  private readonly maxPolls: number;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number | undefined;
  /** Session-scoped user_ids we have ingested under, for precise reset. */
  private readonly knownSessions = new Set<string>();

  constructor(config: Mem0AdapterConfig = {}) {
    this.mode =
      config.mode ??
      (config.baseUrl && !config.baseUrl.includes("api.mem0.ai")
        ? "oss"
        : "hosted");
    this.baseUrl =
      config.baseUrl?.replace(/\/+$/, "") ??
      (this.mode === "hosted" ? "https://api.mem0.ai" : "");
    this.apiKey = config.apiKey;
    // Default to a unique per-instance prefix so independent bench runs don't
    // share a remote namespace. reset() only deletes ids it tracked in-process;
    // a fixed prefix reused by a fresh process would read stale remote data.
    this.userIdPrefix = config.userIdPrefix ?? `memcorrect-${uniqueRunSuffix()}`;
    this.ossAuthMode = config.ossAuthMode ?? "x-api-key";
    this.pollIntervalMs = config.pollIntervalMs ?? 500;
    this.maxPolls = config.maxPolls ?? 120;
    this.fetchImpl = resolveFetch(config.fetch);
    this.timeoutMs = config.timeoutMs;
    this.label = `mem0-${this.mode}`;
  }

  /** Whether this adapter has the credentials needed to run. */
  isConfigured(): boolean {
    if (!this.apiKey) return false;
    if (this.mode === "oss" && !this.baseUrl) return false;
    return true;
  }

  private userIdFor(sessionKey: string): string {
    return `${this.userIdPrefix}:${sessionKey}`;
  }

  private ensureReady(): void {
    const missing: string[] = [];
    if (!this.apiKey) missing.push("apiKey (MEM0_API_KEY)");
    if (this.mode === "oss" && !this.baseUrl)
      missing.push("baseUrl (MEM0_BASE_URL)");
    requireCredentials("Mem0", missing);
  }

  private authHeaders(): Record<string, string> {
    if (this.mode === "hosted") {
      // Hosted platform uses Token auth.
      return { Authorization: `Token ${this.apiKey}` };
    }
    // OSS REST auth: X-API-Key for per-user/API keys (default). Bearer is
    // reserved for dashboard JWTs — available via ossAuthMode: "bearer".
    // https://docs.mem0.ai/open-source/features/rest-api#authentication
    if (this.ossAuthMode === "bearer") {
      return { Authorization: `Bearer ${this.apiKey}` };
    }
    return { "X-API-Key": this.apiKey as string };
  }
  async reset(): Promise<void> {
    this.ensureReady();
    // Delete memories for every session we ingested under. Mem0's DELETE
    // matches exact user_id — the prefix alone does NOT match session-scoped
    // ids like "memcorrect:s1". Tracking known sessions ensures every prior
    // scenario's memories are cleared before the next scenario runs.
    //
    // Only HTTP not-found (404/422) is swallowed: a session with no memories
    // yet is a harmless no-op. Real failures (auth, server error, timeout) are
    // retained for the next reset() retry and rethrown so the bench harness
    // knows per-scenario isolation may be broken rather than silently scoring
    // against stale remote data.
    await resetTrackedIds("Mem0", this.knownSessions, async (sessionKey) => {
      const userId = this.userIdFor(sessionKey);
      if (this.mode === "oss") {
        // OSS: DELETE /memories takes user_id as a query parameter, not body.
        await httpJson(
          this.fetchImpl,
          "DELETE",
          `${this.baseUrl}/memories?user_id=${encodeURIComponent(userId)}`,
          { headers: this.authHeaders(), timeoutMs: this.timeoutMs },
        );
      } else {
        // Hosted: the platform delete API is DELETE /v1/memories/ with
        // identifier filters as query parameters.
        await httpJson(
          this.fetchImpl,
          "DELETE",
          `${this.baseUrl}/v1/memories/?user_id=${encodeURIComponent(userId)}`,
          { headers: this.authHeaders(), timeoutMs: this.timeoutMs },
        );
      }
    });
  }

  async ingestTurn(
    sessionKey: string,
    role: "user" | "assistant",
    text: string,
    _at: string,
  ): Promise<void> {
    this.ensureReady();
    const userId = this.userIdFor(sessionKey);
    this.knownSessions.add(sessionKey);
    if (this.mode === "oss") {
      await httpJson(this.fetchImpl, "POST", `${this.baseUrl}/memories`, {
        headers: this.authHeaders(),
        body: {
          messages: [{ role, content: text }],
          user_id: userId,
        },
        timeoutMs: this.timeoutMs,
      });
    } else {
      // Hosted V3: async add → poll event until processed.
      const addResponse = (await httpJson(
        this.fetchImpl,
        "POST",
        `${this.baseUrl}/v3/memories/add/`,
        {
          headers: this.authHeaders(),
          body: {
            messages: [{ role, content: text }],
            user_id: userId,
          },
          timeoutMs: this.timeoutMs,
        },
      )) as Mem0EventStatus | null;

      if (addResponse?.status === "FAILED") {
        throw new Error(
          `Mem0 hosted add failed immediately: ${addResponse.error ?? addResponse.status}`,
        );
      }
      const eventId = addResponse?.event_id;
      if (eventId) {
        await this.pollEvent(eventId);
      }
    }
  }

  async recall(
    query: string,
    sessionKey: string,
  ): Promise<string[]> {
    this.ensureReady();
    const userId = this.userIdFor(sessionKey);
    let results: Mem0SearchResult[];
    if (this.mode === "oss") {
      const body = (await httpJson(
        this.fetchImpl,
        "POST",
        `${this.baseUrl}/search`,
        {
          headers: this.authHeaders(),
          // Mem0 OSS v3 aligns search with the platform API: entity IDs go
          // inside `filters` and the count parameter is `top_k`, not
          // top-level `user_id`/`limit` (oss-v2-to-v3 migration).
          body: { query, filters: { user_id: userId }, top_k: 10 },
          timeoutMs: this.timeoutMs,
        },
      )) as Mem0SearchResult[] | { results?: Mem0SearchResult[] } | null;
      results = normalizeSearchResults(body);
    } else {
      const body = (await httpJson(
        this.fetchImpl,
        "POST",
        `${this.baseUrl}/v3/memories/search/`,
        {
          headers: this.authHeaders(),
          body: { query, filters: { user_id: userId }, top_k: 10 },
          timeoutMs: this.timeoutMs,
        },
      )) as Mem0SearchResult[] | { results?: Mem0SearchResult[] } | null;
      results = normalizeSearchResults(body);
    }
    return results
      .map((r) => r.memory)
      .filter((m): m is string => typeof m === "string" && m.length > 0);
  }

  async correct(
    text: string,
    sessionKey: string,
    _at?: string,
  ): Promise<void> {
    // Mem0 has no explicit correction-contract API. The correction is
    // observed as a user turn; Mem0's extraction pipeline is expected to
    // update the relevant memory. This faithfully mirrors how a Mem0
    // integrator would apply a user correction in production. The
    // non_resurrection metric measures whether the OLD fact survives.
    await this.ingestTurn(sessionKey, "user", text, _at ?? new Date().toISOString());
  }

  async runMaintenance(): Promise<void> {
    // No-op: Mem0 processes memories during add (OSS synchronously, hosted
    // via the polled event). There is no separate consolidation/dreams step.
    // The protocol runs this N times between phases; a no-op is allowed.
  }

  /** Poll the hosted event endpoint until the add is processed. */
  private async pollEvent(eventId: string): Promise<void> {
    for (let i = 0; i < this.maxPolls; i++) {
      await delay(this.pollIntervalMs);
      const status = (await httpJson(
        this.fetchImpl,
        "GET",
        `${this.baseUrl}/v1/event/${eventId}/`,
        {
          headers: this.authHeaders(),
          timeoutMs: this.timeoutMs,
        },
      )) as Mem0EventStatus | null;
      if (status?.status === "SUCCEEDED") return;
      if (status?.status === "FAILED") {
        throw new Error(
          `Mem0 add event ${eventId} failed: ${status.error ?? "unknown"}`,
        );
      }
      // PENDING / undefined → keep polling.
    }
    throw new Error(
      `Mem0 add event ${eventId} did not complete after ${this.maxPolls} polls`,
    );
  }
}

/**
 * Mem0 search can return either a bare array or `{ results: [...] }` depending
 * on the API version. Normalize to a flat array of search-result objects.
 */
function normalizeSearchResults(
  body: Mem0SearchResult[] | { results?: Mem0SearchResult[] } | null,
): Mem0SearchResult[] {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  return body.results ?? [];
}
