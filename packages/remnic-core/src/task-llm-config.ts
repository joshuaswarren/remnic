/**
 * Honest names for the gateway/task LLM chain (issue #2967).
 *
 * `FallbackLlmClient` is the primary configured path in gateway mode, not a
 * secondary recovery path. `taskLlmTimeoutMs` / `taskLlmFallback` are the
 * current keys. `localLlmTimeoutMs` / `localLlmFallback` remain documented
 * legacy aliases, read only when the corresponding new key is absent.
 */
import { coerceBool, coerceNumber } from "./connectors/coerce.js";
import { log } from "./logger.js";

const DEFAULT_TIMEOUT_MS = 180_000;
const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 86_400_000;

const warnedLegacy = new Set<string>();

export function resetTaskLlmLegacyWarningsForTest(): void {
  warnedLegacy.clear();
}

function warnLegacyOnce(legacyKey: string, currentKey: string, extra: string): void {
  if (warnedLegacy.has(legacyKey)) return;
  warnedLegacy.add(legacyKey);
  log.warn(
    `config: ${legacyKey} is a legacy alias for ${currentKey}; set ${currentKey} instead. ${legacyKey} still works when ${currentKey} is absent. ${extra}`,
  );
}

function parseBoundedIntegerMs(value: unknown, fallback: number): number {
  const coerced = coerceNumber(value);
  if (coerced === undefined) return fallback;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(coerced)));
}

function hasOwnKey(raw: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(raw, key);
}

export interface ParsedTaskLlmConfig {
  timeoutMs: number;
  localTimeoutMs: number;
  fallback: boolean;
}

/**
 * Resolve task-LLM timeout and local→task fallback.
 *
 * New key wins when present (including present-with-`undefined`, which takes
 * the default rather than falling through to the legacy key). Legacy keys are
 * read only when the new key is absent, and warn once per process.
 */
export function parseTaskLlmConfig(cfg: Record<string, unknown>): ParsedTaskLlmConfig {
  const localTimeoutMs = hasOwnKey(cfg, "localLlmTimeoutMs")
    ? parseBoundedIntegerMs(cfg.localLlmTimeoutMs, DEFAULT_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;

  let timeoutMs: number;
  if (hasOwnKey(cfg, "taskLlmTimeoutMs")) {
    timeoutMs = parseBoundedIntegerMs(cfg.taskLlmTimeoutMs, DEFAULT_TIMEOUT_MS);
  } else if (hasOwnKey(cfg, "localLlmTimeoutMs")) {
    warnLegacyOnce(
      "localLlmTimeoutMs",
      "taskLlmTimeoutMs",
      "localLlmTimeoutMs remains the local-endpoint timeout; without taskLlmTimeoutMs it also sizes the gateway/task chain.",
    );
    timeoutMs = localTimeoutMs;
  } else {
    timeoutMs = DEFAULT_TIMEOUT_MS;
  }

  let fallback: boolean;
  if (hasOwnKey(cfg, "taskLlmFallback")) {
    const coerced = coerceBool(cfg.taskLlmFallback, "taskLlmFallback");
    fallback = coerced !== undefined ? coerced : true;
  } else if (hasOwnKey(cfg, "localLlmFallback")) {
    warnLegacyOnce(
      "localLlmFallback",
      "taskLlmFallback",
      "taskLlmFallback is the current name for using the gateway/task chain when the local path fails.",
    );
    fallback = cfg.localLlmFallback !== false;
  } else {
    fallback = true;
  }

  return { timeoutMs, localTimeoutMs, fallback };
}
