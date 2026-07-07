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
 *   - `GET    /sessions/{sessionId}/memory`     — retrieve context (recall)
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

/** Zep memory.get response shape (subset of fields we consume). */
interface ZepMemory {
  context?: string;
  facts?: string[];
  relevant_facts?: Array<{ fact?: string; content?: string }>;
  messages?: Array<{ content?: string; role_type?: string }>;
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

  /** Ensure the Zep session exists before adding memory to it. */
  private async ensureSession(sessionId: string): Promise<void> {
    if (this.knownSessions.has(sessionId)) return;
    try {
      await httpJson(
        this.fetchImpl,
        "POST",
        `${this.baseUrl}/sessions`,
        {
          headers: this.authHeaders(),
          body: { id: sessionId },
          timeoutMs: this.timeoutMs,
        },
      );
    } catch {
      // Session likely already exists (409) — safe to continue.
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
    void query; // Zep's memory.get infers relevance from session context,
    // not an explicit query param — this is the documented one-liner path.
    const memory = (await httpJson(
      this.fetchImpl,
      "GET",
      `${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/memory?lastn=20`,
      { headers: this.authHeaders(), timeoutMs: this.timeoutMs },
    )) as ZepMemory | null;

    if (!memory) return [];

    const strings: string[] = [];
    // Prefer the relevance-ranked context string (Zep's recommended prompt
    // injection). Split on blank-line boundaries to preserve fact structure.
    if (memory.context && memory.context.trim().length > 0) {
      for (const para of memory.context.split(/\n\s*\n/)) {
        const trimmed = para.trim();
        if (trimmed) strings.push(trimmed);
      }
    }
    // Also surface individual relevant facts — they carry the atomic content
    // MemCorrect's token-containment metric checks against.
    if (memory.relevant_facts) {
      for (const fact of memory.relevant_facts) {
        const text = fact.content ?? fact.fact;
        if (text) strings.push(text);
      }
    }
    // Deprecated `facts` array as a last resort.
    if (strings.length === 0 && memory.facts) {
      strings.push(...memory.facts.filter((f) => f && f.length > 0));
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
