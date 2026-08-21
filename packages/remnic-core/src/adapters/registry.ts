import type { AdapterContext, EngramAdapter, ResolvedIdentity } from "./types.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { CodexAdapter } from "./codex.js";
import { ReplitAdapter } from "./replit.js";
import { HermesAdapter } from "./hermes.js";

/**
 * Adapter registry. Attempts to identify which external system is
 * connecting by checking each registered adapter in order. Falls back
 * to explicit namespace/principal from the request args.
 */
export class AdapterRegistry {
  private readonly adapters: EngramAdapter[];

  constructor(adapters?: EngramAdapter[]) {
    this.adapters = adapters ?? [
      new HermesAdapter(),
      new ReplitAdapter(),
      new CodexAdapter(),
      new ClaudeCodeAdapter(),
    ];
  }

  /**
   * Try each adapter in order. Return the first match, or null if
   * no adapter recognizes the request context.
   */
  resolve(context: AdapterContext): ResolvedIdentity | null {
    for (const adapter of this.adapters) {
      if (adapter.matches(context)) {
        return adapter.resolveIdentity(context);
      }
    }
    const namespace = context.namespace?.trim();
    const principal = context.principal?.trim();
    if (namespace && principal) {
      return {
        namespace,
        principal,
        sessionKey: context.sessionKey,
        adapterId: "explicit",
      };
    }
    return null;
  }

  /** List registered adapter IDs */
  list(): string[] {
    return this.adapters.map((a) => a.id);
  }
}
