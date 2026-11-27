
import type { StorageManager } from "../storage.js";
import { buildRetiredFactTombstoneInputs } from "../lifecycle/tombstones.js";
import { supersessionKeysForFact } from "../temporal-supersession.js";
import type { MemoryFile } from "../types.js";

export interface ForgetMemoryRequest {
  id: string;
  reason?: string;
  /** Override the timestamp written to `forgottenAt`. Defaults to `new Date().toISOString()`. */
  now?: () => Date;
}

export interface ForgetMemoryResult {
  id: string;
  path: string;
  priorStatus: string;
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
