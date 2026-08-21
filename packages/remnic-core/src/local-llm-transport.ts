import { Agent, getGlobalDispatcher } from "undici";

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
}

/**
 * Is this undici's stock pooling `Agent` — the transport we may widen?
 *
 * `instanceof` alone is not enough: Node's global fetch is backed by its
 * OWN bundled copy of undici, so the dispatcher parked on the well-known
 * global symbol is an `Agent` from a different copy than the one we import,
 * and cross-copy `instanceof` is false. Fall back to the constructor name,
 * which is stable across copies and still distinguishes `ProxyAgent` and
 * `MockAgent` from the stock pool.
 */
function isPlainPoolingAgent(dispatcher: unknown): boolean {
  if (dispatcher instanceof Agent) return true;
  if (!dispatcher || typeof dispatcher !== "object") return false;
  const ctor = (dispatcher as { constructor?: unknown }).constructor;
  if (!ctor || typeof ctor !== "function") return false;
  return ctor.name === "Agent";
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
  private warnedAboutCustomDispatcher = false;

  /**
   * The widened pool, or `undefined` when the process installed its own
   * transport that we must not displace.
   *
   * A deployment can route the local endpoint through a process-wide
   * dispatcher — a `ProxyAgent` for an HTTP proxy, or a custom
   * connect/TLS/DNS dispatcher. Swapping in our own pool would bypass the
   * proxy entirely and break the request, so those are left alone. A
   * `MockAgent` is excluded by the same check, so test transports keep
   * working. The trade-off is explicit: on those setups the 300s cap stands,
   * because only the dispatcher's owner knows how to rebuild it.
   */
  dispatcherFor(budgetMs: number): Agent | undefined {
    if (!isPlainPoolingAgent(getGlobalDispatcher())) {
      if (!this.warnedAboutCustomDispatcher) {
        this.warnedAboutCustomDispatcher = true;
        log.debug(
          "local LLM: a custom global dispatcher is installed; leaving it in place. " +
            "localLlmTimeoutMs above that dispatcher's headersTimeout will not take effect.",
        );
      }
      return undefined;
    }
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
    const init: RequestInit & { dispatcher?: Agent } = {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: request.signal,
    };
    const dispatcher = this.dispatcherFor(request.budgetMs);
    if (dispatcher) init.dispatcher = dispatcher;
    return await fetch(request.url, init);
  }
}
