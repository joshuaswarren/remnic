import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { Agent } from "undici";

import { log } from "./logger.js";

/**
 * Wire transport for local LLM chat completions.
 *
 * Split out of `local-llm.ts` so the client module keeps prompt and
 * response semantics while connection budgets live in one place.
 */

export interface ChatCompletionRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
  /**
   * Ceiling for this endpoint, i.e. `localLlmTimeoutMs`. Sizes the
   * connection's inactivity budgets. Per-request budgets below the ceiling
   * stay enforced by `signal`.
   */
  budgetMs: number;
  debug?: boolean;
}

/**
 * Connection pool whose header/body inactivity budgets track the configured
 * request budget.
 *
 * Node's global fetch runs on undici, which applies a default
 * `headersTimeout` and `bodyTimeout` of 300s. A non-streaming completion
 * sends its response headers only once generation finishes, so any
 * completion slower than 300s died with a bare `fetch failed` no matter how
 * high `localLlmTimeoutMs` was set — the configured budget was dead letter
 * past five minutes (issue #2148).
 *
 * One pool per client is enough: it is keyed on the ceiling and rebuilt when
 * that changes.
 */
export class ChatTransport {
  private agent: Agent | null = null;
  private agentBudgetMs: number | null = null;

  dispatcherFor(budgetMs: number): Agent {
    const normalized = Number.isFinite(budgetMs) ? Math.max(0, budgetMs) : 0;
    if (this.agent && this.agentBudgetMs === normalized) return this.agent;
    void this.agent?.close().catch(() => {
      /* pool teardown is best-effort */
    });
    this.agent = new Agent({
      headersTimeout: normalized,
      bodyTimeout: normalized,
    });
    this.agentBudgetMs = normalized;
    return this.agent;
  }

  async post(request: ChatCompletionRequest): Promise<Response> {
    if (request.debug) writeDebugRequestBody(request.body);
    return await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: request.signal,
      dispatcher: this.dispatcherFor(request.budgetMs),
    } as RequestInit & { dispatcher: Agent });
  }
}

/** Debug-only: dump the last request body for offline inspection. */
function writeDebugRequestBody(body: string): void {
  try {
    fs.writeFileSync(
      path.join(os.tmpdir(), "remnic-last-request.json"),
      body,
      { mode: 0o600 },
    );
  } catch (err) {
    log.debug(`local LLM: failed to write debug request body: ${err}`);
  }
}
