/**
 * Session-delta surface contract + handler (issue #1548 Track A PR 4).
 *
 * The single shared implementation behind the MCP, HTTP, and CLI
 * session-delta surfaces. All three transports dispatch through the
 * `coding_delta` boundary operation, which calls {@link handleCodingDelta}
 * via the service delegate.
 *
 * Gate (rule 39): `codingKnowledge.enabled + sessionDelta + coding
 * context` — one predicate, identical on every surface. The tools/list
 * visibility gate checks conditions 1–2 only (config-level).
 *
 * Persistence (rule 25): the new last-seen-head marker is written AFTER
 * the delta is computed from the old one. State writes use temp-file-then-
 * rename (rule 54) via the pure module's `writeLastSeenState`.
 *
 * Subcommand: `get` — computes the delta against the persisted last-seen
 * head and updates the marker in the same call (so the NEXT session sees
 * this one as the baseline). Read-only semantically, but it mutates the
 * state file: it is therefore NOT counted against the write-quota (the
 * state file is operator-side bookkeeping, not user memory content — the
 * same way `calibration.ts` writes are uncounted).
 */
import { codingContextLocalRoot } from "../access-coding-context-resolution.js";
import type {
  CodingKnowledgeConfig,
  CodingContext,
} from "../types.js";
import {
  computeSessionDelta,
  readLastSeenState,
  writeLastSeenState,
  resolveSlice,
  sessionDeltaStatePath,
  type GitLogSlice,
  type LastSeenState,
  type ResolveSliceResult,
  type SessionDeltaGitInvoker,
  type SessionDeltaResult,
} from "./session-delta.js";
import { isCodingKnowledgeFeatureEnabled } from "./coding-knowledge-config.js";
import { log } from "../logger.js";

// ──────────────────────────────────────────────────────────────────────────

export const DELTA_SUBCOMMANDS = ["get"] as const;

export type DeltaSubcommand = (typeof DELTA_SUBCOMMANDS)[number];

const SUBCOMMAND_VALUES = DELTA_SUBCOMMANDS as readonly string[];

export function isDeltaSubcommand(value: unknown): value is DeltaSubcommand {
  return typeof value === "string" && SUBCOMMAND_VALUES.includes(value);
}

/** Human-readable subcommand list for error messages (rule 51). */
export function formatDeltaSubcommands(): string {
  return DELTA_SUBCOMMANDS.join(", ");
}


// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

export interface DeltaSurfaceRequest {
  subcommand: DeltaSubcommand;
  sessionKey?: string;
  namespace?: string;
}

/**
 * Surface response. Mirrors {@link SessionDeltaResult} but flattened for
 * transport: every outcome carries `nextState` so callers can observe the
 * new marker even on failure (the head still advanced).
 */
export type DeltaSurfaceResponse =
  | {
      subcommand: "get";
      ok: true;
      kind: "changed";
      delta: {
        commits: ReadonlyArray<{ sha: string; subject: string }>;
        touchedFiles: readonly string[];
        /**
         * Uncapped total commit count (the {@link commits} slice is capped
         * for transport). Issue #1630 fix 1.
         */
        totalCommits: number;
        /**
         * Uncapped total touched-file count (the {@link touchedFiles} slice
         * is capped for transport). Issue #1630 fix 1.
         */
        totalTouchedFiles: number;
        summaryLine: string;
      };
      nextState: LastSeenState;
    }
  | {
      subcommand: "get";
      ok: true;
      kind: "unchanged";
      nextState: LastSeenState;
    }
  | {
      subcommand: "get";
      ok: true;
      kind: "first_run";
      nextState: LastSeenState;
    }
  | {
      subcommand: "get";
      /**
       * Delta unavailable. `code` is one of `unreachable_head` (force-push/
       * rebase erased the prior head) or `git_failed` (invoker error). The
       * state file is still advanced when `nextState` is present.
       */
      ok: false;
      code: "unreachable_head" | "git_failed";
      detail: string;
      nextState?: LastSeenState;
    };

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

export interface DeltaSurfaceStorage {
  readonly memoryDir: string;
  readonly namespace: string;
  /**
   * Whether the calling principal may WRITE the namespace — i.e. advance the
   * last-seen-head marker. Read-only callers (e.g. a principal with read-but-
   * not-write on the shared namespace) receive the computed delta but the
   * state file is NOT advanced, so they cannot move another principal's
   * baseline (issue #1630 fix 2). Defaults to `true` when omitted so existing
   * callers (and the surface contract tests) keep their pre-fix behavior.
   */
  readonly canAdvanceState?: boolean;
}

export interface DeltaSurfaceContext {
  readonly codingKnowledge: CodingKnowledgeConfig;
  getCodingContext(sessionKey: string): CodingContext | null;
  resolveStorage(request: DeltaSurfaceRequest): Promise<DeltaSurfaceStorage>;
  /** Git invoker — drives `rev-parse` + `log`. Defaults to a real invoker. */
  gitInvoker: SessionDeltaGitInvoker;
  throwInputError(message: string): never;
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

export async function handleCodingDelta(
  request: DeltaSurfaceRequest,
  ctx: DeltaSurfaceContext,
): Promise<DeltaSurfaceResponse> {
  const codingContext = request.sessionKey
    ? ctx.getCodingContext(request.sessionKey)
    : null;
  if (
    codingContext === null ||
    !isCodingKnowledgeFeatureEnabled(ctx.codingKnowledge, "sessionDelta", codingContext)
  ) {
    ctx.throwInputError(
      "coding_delta requires codingKnowledge.enabled, codingKnowledge.sessionDelta, and an attached coding context",
    );
  }
  switch (request.subcommand) {
    case "get":
      return deltaGet(request, ctx, codingContext);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

async function deltaGet(
  request: DeltaSurfaceRequest,
  ctx: DeltaSurfaceContext,
  codingContext: CodingContext,
): Promise<DeltaSurfaceResponse> {
  const storage = await ctx.resolveStorage(request);
  const statePath = sessionDeltaStatePath(storage.memoryDir, storage.namespace);

  const lastSeen = await readLastSeenState(statePath);

  const repoRoot = codingContextLocalRoot(codingContext);
  const sliceResult: ResolveSliceResult = resolveSlice(
    repoRoot,
    lastSeen?.head ?? null,
    ctx.gitInvoker,
  );

  if (!sliceResult.ok) {
    log.warn(
      `coding_delta/get: slice resolution failed (code=${sliceResult.code}): ${sliceResult.detail}`,
    );
    return {
      subcommand: "get",
      ok: false,
      code: "git_failed",
      detail: sliceResult.detail,
    };
  }

  const result: SessionDeltaResult = computeSessionDelta(lastSeen, sliceResult.slice);

  //
  const canAdvanceState = storage.canAdvanceState !== false;
  let nextState: LastSeenState | null = null;
  if (result.ok) {
    nextState = result.nextState;
  } else if (result.code === "unreachable_head") {
    nextState = result.nextState;
  }
  if (nextState && canAdvanceState) {
    try {
      await writeLastSeenState(statePath, nextState);
    } catch (err) {
      log.warn(
        `coding_delta/get: state write failed for ${statePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (!result.ok) {
    if (result.code === "unreachable_head") {
      return {
        subcommand: "get",
        ok: false,
        code: result.code,
        detail: result.detail,
        nextState: result.nextState,
      };
    }
    return {
      subcommand: "get",
      ok: false,
      code: result.code,
      detail: result.detail,
    };
  }
  switch (result.kind) {
    case "first_run":
      return { subcommand: "get", ok: true, kind: "first_run", nextState: result.nextState };
    case "unchanged":
      return { subcommand: "get", ok: true, kind: "unchanged", nextState: result.nextState };
    case "changed":
      return {
        subcommand: "get",
        ok: true,
        kind: "changed",
        delta: {
          commits: result.delta.commits,
          touchedFiles: result.delta.touchedFiles,
          totalCommits: result.delta.totalCommits,
          totalTouchedFiles: result.delta.totalTouchedFiles,
          summaryLine: result.delta.summaryLine,
        },
        nextState: result.nextState,
      };
  }
}

// Exported for the surface's storage-adapter glue so the service delegate
// can build the narrow {@link DeltaSurfaceStorage} without re-importing the
// path helper from the pure module.
export { sessionDeltaStatePath, type GitLogSlice };
