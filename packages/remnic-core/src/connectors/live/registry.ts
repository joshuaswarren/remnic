/**
 * @remnic/core — Live Connectors Registry (issue #683 PR 1/N)
 *
 * Pure in-memory registry. No I/O. Concrete connectors register themselves at
 * orchestrator boot (later PRs); the maintenance scheduler asks the registry
 * for the active set when running due syncs.
 */

import { isValidConnectorId, type LiveConnector } from "./framework.js";

/**
 * Thrown when registering a duplicate id or an id that fails validation.
 *
 * Distinct error class so callers can distinguish framework-level mistakes
 * (which are programmer errors) from connector-runtime failures.
 */
export class LiveConnectorRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveConnectorRegistryError";
  }
}

/**
 * In-memory registry of live connectors. One instance per orchestrator. Not
 * safe for cross-process sharing — wire each process to its own registry.
 */
export class LiveConnectorRegistry {
  private readonly connectors = new Map<string, LiveConnector>();

  /**
   * Register a connector. Throws `LiveConnectorRegistryError` if the id is
   * malformed or already registered.
   *
   * Re-registration is rejected (rather than silently overwriting) because
   * silent overwrites mask plugin loading bugs in development and could let
   * a malicious extension shadow a built-in connector.
   */
  register(connector: LiveConnector): void {
    if (!connector || typeof connector !== "object") {
      throw new LiveConnectorRegistryError(
        "register(): connector must be a non-null object",
      );
    }
    if (!isValidConnectorId(connector.id)) {
      throw new LiveConnectorRegistryError(
        `register(): invalid connector id ${JSON.stringify(connector.id)} — must match /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/`,
      );
    }
    if (this.connectors.has(connector.id)) {
      throw new LiveConnectorRegistryError(
        `register(): connector id ${JSON.stringify(connector.id)} is already registered`,
      );
    }
    if (typeof connector.displayName !== "string" || connector.displayName.length === 0) {
      throw new LiveConnectorRegistryError(
        `register(): connector ${connector.id} missing displayName`,
      );
    }
    if (typeof connector.validateConfig !== "function") {
      throw new LiveConnectorRegistryError(
        `register(): connector ${connector.id} missing validateConfig()`,
      );
    }
    if (typeof connector.syncIncremental !== "function") {
      throw new LiveConnectorRegistryError(
        `register(): connector ${connector.id} missing syncIncremental()`,
      );
    }
    this.connectors.set(connector.id, connector);
  }

  /**
   * Look up a connector by id. Returns `undefined` if not registered.
   */
  get(id: string): LiveConnector | undefined {
    return this.connectors.get(id);
  }

  /**
   * Return all registered connectors, sorted by id for stable enumeration.
   */
  list(): LiveConnector[] {
    return Array.from(this.connectors.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Remove a connector. Returns `true` if a connector was removed, `false`
   * otherwise. The cursor / state file on disk is **not** touched — callers
   * who want to fully decommission a connector must also delete its state
   * file via the `state-store` module.
   */
  unregister(id: string): boolean {
    return this.connectors.delete(id);
  }

  /**
   * Number of registered connectors. Cheap; safe to call frequently.
   */
  size(): number {
    return this.connectors.size;
  }
}
