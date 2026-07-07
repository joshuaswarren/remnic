/**
 * Letta MemCorrect adapter (issue #1727 — third priority).
 *
 * Drives Letta (formerly MemGPT) through its public REST API so MemCorrect
 * can score Letta on the same correction/steerability corpus.
 *
 * Letta's model: stateful agents with editable memory blocks. Each
 * MemCorrect session maps to one Letta agent. Messages are sent through
 * `POST /v1/agents/{id}/messages`; the agent autonomously updates its memory
 * blocks via the built-in `memory_insert` / `memory_replace` tools. Recall
 * reads the memory blocks back — this is Letta's normal memory surface, not
 * an internal hack.
 *
 * REST endpoints used (base: operator-provided Letta server URL):
 *   - `POST   /v1/agents/`                    — create a stateful agent
 *   - `POST   /v1/agents/{id}/messages`       — send a user message (ingest + correct)
 *   - `GET    /v1/agents/{id}/core-memory/blocks` — read memory blocks (recall)
 *   - `DELETE /v1/agents/{id}`                — destroy agent (reset)
 *
 * The adapter accepts an injectable `fetch` so the deterministic fixture
 * smoke test exercises the full request/response cycle without a network.
 */

import type { MemCorrectSystemAdapter } from "../types.js";
import {
  httpJson,
  isNotFoundDelete,
  requireCredentials,
  resolveFetch,
  type FetchLike,
  type ThirdPartyAdapterConfig,
} from "./shared.js";

export interface LettaAdapterConfig extends ThirdPartyAdapterConfig {
  /** LLM model handle for created agents (e.g. "openai/gpt-4o"). Required. */
  model?: string;
  /** Prefix for agent names to namespace them from other Letta agents. */
  agentNamePrefix?: string;
  /** Persona block content for created agents. */
  personaBlock?: string;
}

/** Letta agent creation response (subset). */
interface LettaAgent {
  id?: string;
}

/** Letta memory block. */
interface LettaBlock {
  label?: string;
  value?: string;
  text?: string;
  content?: string;
}

/** Letta memory response: may be `{memory: [...]}` or `{blocks: [...]}`. */
interface LettaMemoryResponse {
  memory?: LettaBlock[];
  blocks?: LettaBlock[];
}

/**
 * MemCorrect adapter for Letta. Construct with operator-provided credentials;
 * pass a `fetch` override for deterministic testing.
 */
export class LettaMemCorrectAdapter implements MemCorrectSystemAdapter {
  readonly label = "letta";
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly model: string | undefined;
  private readonly agentNamePrefix: string;
  private readonly personaBlock: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number | undefined;
  /** Maps MemCorrect sessionKey → Letta agent_id. */
  private readonly agentsBySession = new Map<string, string>();

  constructor(config: LettaAdapterConfig = {}) {
    this.baseUrl = config.baseUrl?.replace(/\/+$/, "") ?? "";
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.agentNamePrefix = config.agentNamePrefix ?? "memcorrect";
    this.personaBlock =
      config.personaBlock ??
      "You are a memory benchmark agent. Store every fact the user states in " +
        "your human memory block. When the user corrects a fact, use " +
        "memory_replace to update it.";
    this.fetchImpl = resolveFetch(config.fetch);
    this.timeoutMs = config.timeoutMs;
  }

  isConfigured(): boolean {
    return !!(this.apiKey && this.baseUrl && this.model);
  }

  private ensureReady(): void {
    const missing: string[] = [];
    if (!this.apiKey) missing.push("apiKey (LETTA_API_KEY)");
    if (!this.baseUrl) missing.push("baseUrl (LETTA_BASE_URL)");
    if (!this.model) missing.push("model (LETTA_MODEL)");
    requireCredentials("Letta", missing);
  }

  private authHeaders(): Record<string, string> {
    // Letta uses Bearer auth (password token) or no auth for local dev.
    return this.apiKey
      ? { Authorization: `Bearer ${this.apiKey}` }
      : {};
  }

  async reset(): Promise<void> {
    this.ensureReady();
    // Destroy every agent created during this bench process for a clean slate.
    // Remove each session→agent mapping as its delete succeeds (or is not-found)
    // so a partial failure cannot leave mappings to already-deleted agents —
    // otherwise ensureAgent would hand back a cached id for a dead agent. Real
    // failures (auth, server error, timeout) retain the mapping for the next
    // reset() retry and rethrow so a broken clean-slate surfaces.
    const failed: string[] = [];
    for (const [sessionKey, agentId] of [...this.agentsBySession]) {
      try {
        await httpJson(
          this.fetchImpl,
          "DELETE",
          `${this.baseUrl}/v1/agents/${encodeURIComponent(agentId)}`,
          { headers: this.authHeaders(), timeoutMs: this.timeoutMs },
        );
        this.agentsBySession.delete(sessionKey);
      } catch (err) {
        if (isNotFoundDelete(err)) {
          this.agentsBySession.delete(sessionKey);
        } else {
          failed.push(agentId);
        }
      }
    }
    if (failed.length > 0) {
      throw new Error(
        `Letta reset could not clean ${failed.length} agent(s): ${failed.join(", ")}. ` +
          `The failed agents are retained in agentsBySession for the next reset() retry.`,
      );
    }
  }

  /** Create a Letta agent for the session if one does not yet exist. */
  private async ensureAgent(sessionKey: string): Promise<string> {
    const existing = this.agentsBySession.get(sessionKey);
    if (existing) return existing;

    const agent = (await httpJson(
      this.fetchImpl,
      "POST",
      `${this.baseUrl}/v1/agents/`,
      {
        headers: this.authHeaders(),
        body: {
          name: `${this.agentNamePrefix}-${sessionKey}`,
          agent_type: "memgpt_agent",
          model: this.model,
          memory_blocks: [
            { label: "human", value: "", limit: 5000 },
            { label: "persona", value: this.personaBlock, limit: 5000 },
          ],
        },
        timeoutMs: this.timeoutMs,
      },
    )) as LettaAgent | null;

    const agentId = agent?.id;
    if (!agentId) {
      throw new Error(
        `Letta agent creation did not return an agent id for session ${sessionKey}`,
      );
    }
    this.agentsBySession.set(sessionKey, agentId);
    return agentId;
  }

  async ingestTurn(
    sessionKey: string,
    role: "user" | "assistant",
    text: string,
    _at: string,
  ): Promise<void> {
    this.ensureReady();
    const agentId = await this.ensureAgent(sessionKey);
    // Send the message through the agent. The agent processes it and
    // autonomously updates its memory blocks via memory_insert/memory_replace.
    // We use stream=false to get a complete response.
    await httpJson(
      this.fetchImpl,
      "POST",
      `${this.baseUrl}/v1/agents/${encodeURIComponent(agentId)}/messages`,
      {
        headers: this.authHeaders(),
        body: {
          messages: [{ role, content: text }],
        },
        timeoutMs: this.timeoutMs,
      },
    );
  }

  async recall(_query: string, sessionKey: string): Promise<string[]> {
    this.ensureReady();
    const agentId = await this.ensureAgent(sessionKey);
    // Read the agent's memory blocks — this is Letta's normal memory surface.
    // The blocks contain the facts the agent has extracted and stored.
    const response = (await httpJson(
      this.fetchImpl,
      "GET",
      `${this.baseUrl}/v1/agents/${encodeURIComponent(agentId)}/core-memory/blocks`,
      { headers: this.authHeaders(), timeoutMs: this.timeoutMs },
    )) as LettaMemoryResponse | LettaBlock[] | null;

    if (!response) return [];
    // The documented endpoint returns a bare array of blocks. Older Letta
    // servers and some fixtures wrap them in `{memory: [...]}` or
    // `{blocks: [...]}` — accept all three for robustness.
    const blocks = Array.isArray(response)
      ? response
      : response.memory ?? response.blocks ?? [];
    const strings: string[] = [];
    for (const block of blocks) {
      // Skip the persona block — it's agent behavior config, not user facts.
      if (block.label === "persona") continue;
      const value = block.value ?? block.text ?? block.content;
      if (value && value.trim().length > 0) {
        // Split multi-line block content into individual lines so each fact
        // is a separate recalled string (MemCorrect scores token containment
        // over individual strings, not a monolithic blob).
        for (const line of value.split(/\n+/)) {
          const trimmed = line.trim();
          if (trimmed) strings.push(trimmed);
        }
      }
    }
    return strings;
  }

  async correct(text: string, sessionKey: string, _at?: string): Promise<void> {
    // Letta agents have memory_replace/memory_insert tools. Sending the
    // correction as a user message triggers the agent to update its memory
    // blocks. non_resurrection measures whether the old fact survives.
    await this.ingestTurn(
      sessionKey,
      "user",
      text,
      _at ?? new Date().toISOString(),
    );
  }

  async runMaintenance(): Promise<void> {
    // No-op: Letta agents process messages synchronously and self-manage
    // memory. There is no separate consolidation/dreams step to invoke.
    // The protocol runs this N times between phases; a no-op is allowed.
  }
}
