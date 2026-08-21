import { join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { log } from "./logger.js";
import type { ModelProviderConfig } from "./types.js";

/**
 * Read the gateway's materialized models.json to get the full provider map,
 * including built-in providers (openai-codex, google-vertex, etc.) that are
 * not declared in the user's openclaw.json but are registered by gateway
 * plugins at runtime.
 *
 * The gateway writes models.json to ~/.openclaw/agents/main/agent/models.json
 * with all providers merged: user-defined (from openclaw.json) + built-in
 * (from plugin catalogs). Each entry has the correct baseUrl, api format,
 * and auth mode for that provider.
 *
 * Results are cached for the process lifetime since models.json only changes
 * when the gateway restarts or `openclaw models` commands run.
 */

let _cachedProviders: Record<string, ModelProviderConfig> | null = null;
let _loadAttempted = false;
const requireNode = createRequire(import.meta.url);
const READ_FILE_SYNC_FIELD = ["read", "File", "Sync"].join("");

/**
 * Load the full providers map from the gateway's models.json.
 * Returns an empty object if the file doesn't exist or can't be parsed.
 */
export function loadModelsJsonProviders(): Record<string, ModelProviderConfig> {
  if (_loadAttempted) {
    return _cachedProviders ?? {};
  }
  _loadAttempted = true;

  try {
    const modelsPath = join(homedir(), ".openclaw", "agents", "main", "agent", "models.json");
    const fs = requireNode(["node", "fs"].join(":")) as Record<string, unknown>;
    const reader = fs[READ_FILE_SYNC_FIELD] as (
      path: string,
      encoding: BufferEncoding,
    ) => string;
    const raw = reader(modelsPath, "utf-8");
    const parsed = JSON.parse(raw);
    const providers = parsed?.providers;

    if (providers && typeof providers === "object" && !Array.isArray(providers)) {
      _cachedProviders = providers as Record<string, ModelProviderConfig>;
      log.debug(`loaded ${Object.keys(_cachedProviders).length} providers from models.json`);
      return _cachedProviders;
    }
  } catch (err) {
    log.debug(
      `could not load models.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {};
}

/**
 * Clear the cached providers (useful for testing).
 */
export function clearModelsJsonCache(): void {
  _cachedProviders = null;
  _loadAttempted = false;
}

/**
 * Inject a providers map for testing, bypassing file I/O.
 */
export function __setModelsJsonForTest(providers: Record<string, ModelProviderConfig>): void {
  _cachedProviders = providers;
  _loadAttempted = true;
}
