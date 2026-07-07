/**
 * Zep MemCorrect adapter (issue #1727 — second priority).
 *
 * Drives Zep through its public v2 REST API so MemCorrect can score Zep on the
 * same correction/steerability corpus as the Remnic adapter.
 *
 * Zep's model: sessions are the ingestion unit; `memory.add` ingests chat
 * messages into a session and builds a user-level knowledge graph; `memory.get`
 * retrieves a relevance-ranked context string for the prompt. This adapter
 * uses the documented high-level Memory API — the same path a Zep integrator
 * follows in production. Reaching into the graph internals would not be a
 * faithful exercise of Zep's normal recall path.
 *
 * REST endpoints used (base: `https://api.getzep.com/api/v2`):
 *   - `POST   /sessions/{sessionId}`            — ensure session exists
 *   - `POST   /sessions/{sessionId}/memory`     — add messages (ingest + correct)
 *   - `POST   /graph/search`                    — query-driven fact recall
 *   - `DELETE /sessions/{sessionId}`            — full clean slate (reset)
 *
 * The adapter accepts an injectable `fetch` so the deterministic fixture smoke
 * test exercises the full request/response cycle without a network. No keys
 * are embedded; without operator-provided credentials every method throws
 * `MissingCredentialError` (skip-with-reason — no keys in CI).
 */

import type { MemCorrectSystemAdapter } from "../types.js";
import {
  delay,
  httpJson,
  requireCredentials,
  resolveFetch,
  type FetchLike,
  type ThirdPartyAdapterConfig,
} from "./shared.js";

export interface ZepAdapterConfig extends ThirdPartyAdapterConfig {
  /** Prefix prepended to sessionKeys to namespace Zep session IDs. */
  sessionPrefix?: string;
  /**
   * Milliseconds to wait after ingest before a probe, so Zep's asynchronous
   * graph processing has time to settle. Zep documentation notes ingestion
   * "can take a few minutes"; for benchmark reproducibility this is a tunable
   * settle delay. Default 0 (runMaintenance provides the settle point).
   */
  settleMs?: number;
}

/** Zep graph search result (subset of fields we consume). */
interface ZepGraphSearchResults {
  edges?: Array<{ fact?: string }>;
  nodes?: Array<{ summary?: string }>;
  episodes?: Array<{ content?: string }>;
}

/** Zep role_type enum. */
type ZepRoleType = "norole" | "system" | "assistant" | "user" | "function" | "tool";

/**
 * MemCorrect adapter for Zep. Construct with operator-provided credentials;
 * pass a `fetch` override for deterministic testing.
 */
export class ZepMemCorrectAdapter implements MemCorrectSystemAdapter {
  readonly label = "zep";
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly sessionPrefix: string;
  private readonly settleMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number | undefined;
  /** Sessions we have ensured exist, to avoid redundant POST /sessions calls. */
  private readonly knownSessions = new Set<string>();

  constructor(config: ZepAdapterConfig = {}) {
    this.baseUrl =
      config.baseUrl?.replace(/\/+$/, "") ?? "https://api.getzep.com/api/v2";
    this.apiKey = config.apiKey;
    this.sessionPrefix = config.sessionPrefix ?? "memcorrect";
    this.settleMs = config.settleMs ?? 0;
    this.fetchImpl = resolveFetch(config.fetch);
    this.timeoutMs = config.timeoutMs;
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  private sessionIdFor(sessionKey: string): string {
    return `${this.sessionPrefix}:${sessionKey}`;
  }

  private ensureReady(): void {
    requireCredentials("Zep", this.apiKey ? [] : ["apiKey (ZEP_API_KEY)"]);
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Api-Key ${this.apiKey}` };
  }

  async reset(): Promise<void> {
    this.ensureReady();
    // Delete every known session for a clean slate. The runner calls reset()
    // before each scenario, so this clears only sessions created during the
    // current bench process. A server-side reset (delete all) is intentionally
    // NOT called to avoid destroying unrelated operator data.
    for (const sessionId of this.knownSessions) {
      try {
        await httpJson(
          this.fetchImpl,
          "DELETE",
          `${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}`,
          { headers: this.authHeaders(), timeoutMs: this.timeoutMs },
        );
      } catch {
        // Session may not exist yet (first reset) — swallow.
      }
    }
    this.knownSessions.clear();
  }

  /** Ensure the Zep session (and its user) exist before adding memory. */
  private async ensureSession(sessionId: string): Promise<void> {
    if (this.knownSessions.has(sessionId)) return;
    // Zep v2 requires a user to exist before a session references it. Each
    // MemCorrect session gets its own user for namespace isolation.
    try {
      await httpJson(this.fetchImpl, "POST", `${this.baseUrl}/users`, {
        headers: this.authHeaders(),
        body: { user_id: sessionId },
        timeoutMs: this.timeoutMs,
      });
    } catch {
      // User may already exist from a prior run — safe to continue.
    }
    try {
      await httpJson(
        this.fetchImpl,
        "POST",
        `${this.baseUrl}/sessions`,
        {
          headers: this.authHeaders(),
          body: { session_id: sessionId, user_id: sessionId },
          timeoutMs: this.timeoutMs,
        },
      );
    } catch {
      // Session may already exist (409) — safe to continue.
    }
    this.knownSessions.add(sessionId);
  }

  async ingestTurn(
    sessionKey: string,
    role: "user" | "assistant",
    text: string,
    _at: string,
  ): Promise<void> {
    this.ensureReady();
    const sessionId = this.sessionIdFor(sessionKey);
    await this.ensureSession(sessionId);
    const roleType: ZepRoleType = role === "user" ? "user" : "assistant";
    await httpJson(
      this.fetchImpl,
      "POST",
      `${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/memory`,
      {
        headers: this.authHeaders(),
        body: {
          messages: [{ role, role_type: roleType, content: text }],
        },
        timeoutMs: this.timeoutMs,
      },
    );
  }

  async recall(query: string, sessionKey: string): Promise<string[]> {
    this.ensureReady();
    const sessionId = this.sessionIdFor(sessionKey);
    await this.ensureSession(sessionId);
    // Query-driven recall via Zep's graph search. The MemCorrect runner passes
    // the scored probe only as recall(query, …) — it is never added to the
    // session — so memory.get (which ranks by the *last ingested message*)
    // would retrieve the wrong context. Graph search ranks facts by the probe
    // text itself, which is what MemCorrect scores. Each MemCorrect session
    // gets its own user (see ensureSession), so we scope the search to that
    // user's graph. Edges carry atomic `fact` strings — the exact unit
    // MemCorrect's token-containment metric checks against.
    const results = (await httpJson(
      this.fetchImpl,
      "POST",
      `${this.baseUrl}/graph/search`,
      {
        headers: this.authHeaders(),
        body: { user_id: sessionId, query, scope: "edges", limit: 10 },
        timeoutMs: this.timeoutMs,
      },
    )) as ZepGraphSearchResults | null;

    if (!results || !results.edges) return [];

    const strings: string[] = [];
    for (const edge of results.edges) {
      const fact = edge.fact;
      if (fact && fact.trim().length > 0) {
        strings.push(fact.trim());
      }
    }
    return strings;
  }

  async correct(text: string, sessionKey: string, _at?: string): Promise<void> {
    // Zep has no explicit correction-contract API. The correction is observed
    // as a user turn through the normal memory.add path; Zep's graph extraction
    // is expected to update the relevant fact. non_resurrection measures
    // whether the retired fact survives the next maintenance + re-ingest cycle.
    await this.ingestTurn(
      sessionKey,
      "user",
      text,
      _at ?? new Date().toISOString(),
    );
  }

  async runMaintenance(): Promise<void> {
    // Zep processes the graph asynchronously after memory.add. The settle
    // delay gives the pipeline time to extract facts before the next probe.
    // A no-op is allowed by the MemCorrect protocol; this delay is a
    // best-effort settle for reproducibility.
    if (this.settleMs > 0) {
      await delay(this.settleMs);
    }
  }
}
