/**
 * Operator-facing memory forgetting (issue #686 PR 4/6).
 *
 * `remnic forget <id>` marks a memory as forgotten — a soft-delete that:
 *
 *   1. Sets `status: "forgotten"`, `forgottenAt`, optional
 *      `forgottenReason` in YAML frontmatter via the existing
 *      `storage.writeMemoryFrontmatter` path (which logs the change
 *      to the lifecycle ledger and invalidates caches).
 *   2. Returns a structured result describing what changed so the
 *      CLI and downstream telemetry can render it.
 *
 * Memories with `status === "forgotten"` are excluded from recall,
 * browse, and entity attribution by the status filters that serve
 * active user context.  A future maintenance cron will hard-delete
 * forgotten memories after a configurable retention window (default
 * 90 days) — for this PR the file stays on disk and the act is
 * reversible by editing the YAML directly.
 *
 * This module ships the pure helper; the CLI wires it in `cli.ts` as
 * a new `remnic forget` subcommand.
 */

import type { StorageManager } from "../storage.js";
import { buildRetiredFactTombstoneInputs } from "../lifecycle/tombstones.js";
import { supersessionKeysForFact } from "../temporal-supersession.js";
import type { MemoryFile } from "../types.js";

export interface ForgetMemoryRequest {
  /** Memory id (frontmatter `id`) to forget. */
  id: string;
  /** Optional human-readable reason. */
  reason?: string;
  /** Override the timestamp written to `forgottenAt`. Defaults to `new Date().toISOString()`. */
  now?: () => Date;
}

export interface ForgetMemoryResult {
  /** Memory id that was forgotten. */
  id: string;
  /** Filesystem path of the forgotten memory. */
  path: string;
  /** Prior status before the forget call, for audit. */
  priorStatus: string;
  /** Timestamp written to `forgottenAt`. */
  forgottenAt: string;
  /** Reason captured (or empty string if none). */
  reason: string;
}

export class ForgetMemoryNotFoundError extends Error {
  readonly code = "memory_not_found" as const;
  constructor(id: string) {
    super(`memory not found: ${id}`);
    this.name = "ForgetMemoryNotFoundError";
  }
}

export class ForgetMemoryAlreadyForgottenError extends Error {
  readonly code = "already_forgotten" as const;
  constructor(id: string, forgottenAt: string) {
    super(`memory ${id} was already forgotten at ${forgottenAt}`);
    this.name = "ForgetMemoryAlreadyForgottenError";
  }
}

/**
 * Mark a memory as forgotten.  Pure orchestration over storage —
 * caller supplies the storage instance and the request.  Status
 * filters elsewhere in the codebase exclude `status: "forgotten"`
 * from recall/browse surfaces before they serve active user context.
 */
export async function forgetMemory(
  storage: StorageManager,
  request: ForgetMemoryRequest,
): Promise<ForgetMemoryResult> {
  const id = typeof request.id === "string" ? request.id.trim() : "";
  if (id.length === 0) {
    throw new Error("forget: memory id is required and must be non-empty");
  }
  const memory = await findMemoryById(storage, id);
  if (!memory) {
    throw new ForgetMemoryNotFoundError(id);
  }
  if (memory.frontmatter.status === "forgotten") {
    throw new ForgetMemoryAlreadyForgottenError(
      id,
      memory.frontmatter.forgottenAt ?? "(unknown)",
    );
  }
  const priorStatus =
    typeof memory.frontmatter.status === "string" ? memory.frontmatter.status : "active";
  const now = (request.now ?? (() => new Date()))();
  const forgottenAt = now.toISOString();
  const reason = typeof request.reason === "string" ? request.reason.trim() : "";
  await storage.writeMemoryFrontmatter(memory, {
    status: "forgotten",
    forgottenAt,
    forgottenReason: reason.length > 0 ? reason : undefined,
    updated: forgottenAt,
  }, {
    actor: "remnic-forget",
    reasonCode: "operator_forget",
  });
  // Issue #1579 thread OchiF: emit a LIVE tombstone at forget time so a
  // forgotten FACT cannot resurrect via re-extraction/import before an
  // operator runs `remnic doctor --rebuild-tombstones`. Without this, the
  // non-resurrection chokepoint in writeMemory has nothing to match — the
  // forgotten fact's content hash is gone from the active index but no
  // tombstone exists until a manual rebuild derives one — so the same fact
  // written again through writeMemory becomes active. Mirrors supersedeMemory
  // (contradiction) and applyTemporalSupersession via the shared
  // buildRetiredFactTombstoneInputs helper. Best-effort (rule 34): a tombstone
  // append failure must not fail the forget, which already succeeded on disk.
  if (memory.frontmatter.category === "fact") {
    for (const input of buildRetiredFactTombstoneInputs(
      {
        id,
        content: memory.content,
        ...(memory.frontmatter.contentHash
          ? { contentHash: memory.frontmatter.contentHash }
          : {}),
        ...(memory.frontmatter.entityRef
          ? { entityRef: memory.frontmatter.entityRef }
          : {}),
        ...(memory.frontmatter.structuredAttributes
          ? { structuredAttributes: memory.frontmatter.structuredAttributes }
          : {}),
      },
      {
        reason: "retraction",
        createdBy: "user_correction",
        createdAt: forgottenAt,
        supersessionKeysForFact,
      },
    )) {
      try {
        await storage.appendTombstone(input);
      } catch {
        // Best-effort — the forget already succeeded on disk.
      }
    }
  }
  return {
    id,
    path: memory.path,
    priorStatus,
    forgottenAt,
    reason,
  };
}

async function findMemoryById(
  storage: StorageManager,
  id: string,
): Promise<MemoryFile | null> {
  const hot = await storage.readAllMemories();
  const hotMatch = hot.find((m) => m.frontmatter.id === id);
  if (hotMatch) return hotMatch;

  const archived = await storage.readArchivedMemories();
  const archivedMatch = archived.find((m) => m.frontmatter.id === id);
  if (archivedMatch) return archivedMatch;

  const cold = await storage.readAllColdMemories();
  return cold.find((m) => m.frontmatter.id === id) ?? null;
}
