/**
 * Bounded, one-hop invalidation propagation for linked memories.
 *
 * Propagation hooks stay at orchestration call sites. They never live inside
 * StorageManager, so propagation supersessions cannot recurse.
 */
import type { ExtractionEngine } from "../extraction.js";
import { log } from "../logger.js";
import type { StorageManager } from "../index.js";
import type {
  MemoryFile,
  MemoryFrontmatter,
  MemoryLinkType,
  PluginConfig,
} from "../types.js";

export interface PropagationEvent {
  /** Snapshot captured before the primary supersession or deletion. */
  oldMemory: { content: string; frontmatter: MemoryFrontmatter };
  replacementId: string | null;
  replacementContent: string | null;
  cause:
    | "contradiction"
    | "temporal_supersession"
    | "consolidation_invalidate"
    | "consolidation_merge";
  namespaceScope: string;
}

export interface PropagationResult {
  dependentsFound: number;
  invalidated: number;
  stillValid: number;
  uncertain: number;
  skipped: "disabled" | "no_dependents" | "llm_error" | "timeout" | null;
}

interface DependencyPropagationConfig {
  enabled?: boolean | string;
  linkTypes?: MemoryLinkType[] | string[];
  maxDependents?: number;
  timeoutMs?: number;
  dryRun?: boolean | string;
}

function propagationConfig(config: PluginConfig): DependencyPropagationConfig {
  return (config as PluginConfig & { dependencyPropagation?: DependencyPropagationConfig })
    .dependencyPropagation ?? {};
}

function isEnabled(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
}

function isTruthy(value: unknown): boolean {
  if (value === false || value === 0 || value === null || value === undefined) return false;
  if (typeof value === "string") {
    return !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase());
  }
  return Boolean(value);
}

const ACTIVE_STATUS = "active";

/**
 * Discover exactly one-hop dependents from a memory snapshot.
 *
 * A supports edge on the dying memory points forward to its dependent.
 * follows and configured references edges point back to the dying memory.
 */
export function findDependents(
  memories: MemoryFile[],
  oldMemory: Pick<PropagationEvent["oldMemory"], "frontmatter">,
  linkTypes: readonly MemoryLinkType[] = ["supports", "follows"],
): MemoryFile[] {
  const allowed = new Set(linkTypes);
  const ids = new Set<string>();
  const byId = new Map(memories.map((memory) => [memory.frontmatter.id, memory]));

  // Forward: supports and references edges on the dying memory point to
  // dependents that lose evidence or a referenced anchor.
  for (const link of oldMemory.frontmatter.links ?? []) {
    if (link.linkType !== "supports" && link.linkType !== "references") continue;
    if (!allowed.has(link.linkType)) continue;
    const dependent = byId.get(link.targetId);
    if (dependent && (dependent.frontmatter.status ?? ACTIVE_STATUS) === ACTIVE_STATUS) {
      ids.add(dependent.frontmatter.id);
    }
  }

  const oldId = oldMemory.frontmatter.id;
  for (const memory of memories) {
    if ((memory.frontmatter.status ?? ACTIVE_STATUS) !== ACTIVE_STATUS) continue;
    if (memory.frontmatter.id === oldId) continue;
    for (const link of memory.frontmatter.links ?? []) {
      if (link.targetId !== oldId) continue;
      if (link.linkType !== "follows" && link.linkType !== "references") continue;
      if (!allowed.has(link.linkType)) continue;
      ids.add(memory.frontmatter.id);
    }
  }

  return Array.from(ids)
    .map((id) => byId.get(id))
    .filter((memory): memory is MemoryFile => memory !== undefined)
    .sort((a, b) => {
      const left = a.frontmatter.id;
      const right = b.frontmatter.id;
      return left < right ? -1 : left > right ? 1 : 0;
    });
}

function emptyResult(skipped: PropagationResult["skipped"]): PropagationResult {
  return { dependentsFound: 0, invalidated: 0, stillValid: 0, uncertain: 0, skipped };
}

function logResult(event: PropagationEvent, result: PropagationResult): void {
  const oldId = event.oldMemory.frontmatter.id;
  log.info(
    `dependency-propagation ${JSON.stringify({
      cause: event.cause,
      oldId,
      dependentsFound: result.dependentsFound,
      invalidated: result.invalidated,
      stillValid: result.stillValid,
      uncertain: result.uncertain,
      skipped: result.skipped,
    })}`,
  );
}

class PropagationTimeoutError extends Error {
  constructor() {
    super("dependency propagation timed out");
    this.name = "PropagationTimeoutError";
  }
}

function isTimeoutError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || error instanceof PropagationTimeoutError ||
    (error instanceof Error && (error.name === "AbortError" || /timeout|timed out/i.test(error.message)));
}

/**
 * Revalidate one-hop dependents after a successful primary operation.
 * The caller's storage is already namespace-scoped; this function never
 * constructs another storage or scans a different namespace.
 */
export async function propagateInvalidation(
  deps: { storage: StorageManager; extraction: ExtractionEngine; config: PluginConfig },
  event: PropagationEvent,
): Promise<PropagationResult> {
  const config = propagationConfig(deps.config);
  if (!isEnabled(config.enabled)) {
    const result = emptyResult("disabled");
    logResult(event, result);
    return result;
  }


  const maxDependents = Number(config.maxDependents ?? 10);
  if (!Number.isFinite(maxDependents) || maxDependents <= 0) {
    const result = emptyResult("no_dependents");
    logResult(event, result);
    return result;
  }

  let memories: MemoryFile[];
  try {
    memories = await deps.storage.readAllMemories();
  } catch (error) {
    log.warn(`dependency propagation discovery failed for ${event.oldMemory.frontmatter.id}: ${error}`);
    const result = emptyResult("llm_error");
    logResult(event, result);
    return result;
  }

  const discovered = findDependents(
    memories,
    event.oldMemory,
    Array.isArray(config.linkTypes) ? (config.linkTypes as MemoryLinkType[]) : ["supports", "follows"],
  );
  const dependents = discovered.slice(0, Math.max(0, Math.floor(maxDependents)));
  if (dependents.length === 0) {
    const result = emptyResult("no_dependents");
    logResult(event, result);
    return result;
  }

  const controller = new AbortController();
  const timeoutMs = Number(config.timeoutMs ?? 20_000);
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => controller.abort(new PropagationTimeoutError()), timeoutMs)
    : undefined;

  let verdicts: Array<{ memoryId: string; verdict: "still_valid" | "invalidated" | "uncertain"; reason?: string }>;
  try {
    const response = await deps.extraction.revalidateDependents(
      { id: event.oldMemory.frontmatter.id, content: event.oldMemory.content },
      event.replacementId && event.replacementContent !== null
        ? { id: event.replacementId, content: event.replacementContent }
        : null,
      dependents.map((memory) => ({
        id: memory.frontmatter.id,
        category: memory.frontmatter.category,
        content: memory.content,
      })),
      controller.signal,
    );
    verdicts = response.verdicts;
    if (controller.signal.aborted) {
      if (timeout !== undefined) clearTimeout(timeout);
      const result = emptyResult("timeout");
      logResult(event, result);
      return result;
    }
  } catch (error) {
    const result = emptyResult(isTimeoutError(error, controller.signal) ? "timeout" : "llm_error");
    log.warn(`dependency propagation revalidation failed for ${event.oldMemory.frontmatter.id}: ${error}`);
    logResult(event, result);
    if (timeout !== undefined) clearTimeout(timeout);
    return result;
  }
  if (timeout !== undefined) clearTimeout(timeout);

  let invalidated = 0;
  let stillValid = 0;
  let uncertain = 0;
  for (const dependent of dependents) {
    const verdict = verdicts.find((candidate) => candidate.memoryId === dependent.frontmatter.id);
    if (verdict?.verdict === "invalidated") {
      if (isTruthy(config.dryRun)) {
        invalidated += 1;
        continue;
      }
      try {
        const replacementId = event.replacementId ?? event.oldMemory.frontmatter.id;
        const superseded = await deps.storage.supersedeMemory(
          dependent.frontmatter.id,
          replacementId,
          `dependency_propagation:${event.cause}`,
        );
        if (!superseded) continue;
        const current = await deps.storage.getMemoryById(dependent.frontmatter.id);
        if (current) {
          await deps.storage.writeMemoryFrontmatter(current, {
            supersessionCause: "dependency",
            invalidatedBy: event.oldMemory.frontmatter.id,
          });
        }
        invalidated += 1;
      } catch (error) {
        log.warn(`dependency propagation write failed for ${dependent.frontmatter.id}: ${error}`);
      }
      continue;
    }
    if (verdict?.verdict === "still_valid") {
      stillValid += 1;
    } else {
      uncertain += 1;
      log.info(`dependency propagation uncertain for ${dependent.frontmatter.id}`);
    }
  }

  const result: PropagationResult = {
    dependentsFound: dependents.length,
    invalidated,
    stillValid,
    uncertain,
    skipped: null,
  };
  logResult(event, result);
  return result;
}
