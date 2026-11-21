import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { EngramAccessInputError } from "./access-errors.js";
import { codingContextSchema } from "./access-schema.js";
import { resolveNamespaceCapabilities } from "./capabilities.js";
import { projectTagProjectId } from "./coding/coding-namespace.js";
import { resolveGitContext, sharedGitContextCache } from "./coding/git-context.js";
import { resolvePrincipal } from "./namespaces/principal.js";
import type { Orchestrator } from "./orchestrator.js";
import type { CodingContext } from "./types.js";

export interface InterruptibleCodingScopeInput {
  cwd?: string;
  projectTag?: string;
  abortSignal?: AbortSignal;
  deadlineMs?: number;
}

export async function resolveCodingContextFromOptions(
  options: InterruptibleCodingScopeInput,
): Promise<CodingContext | null> {
  if (typeof options.projectTag === "string" && options.projectTag.trim().length > 0) {
    const projectId = projectTagProjectId(options.projectTag);
    return { projectId, branch: null, rootPath: projectId, defaultBranch: null };
  }
  if (typeof options.cwd !== "string" || options.cwd.trim().length === 0) return null;

  try {
    const gitContext = await resolveGitContext(options.cwd, {
      abortSignal: options.abortSignal,
      deadlineMs: options.deadlineMs,
      cache: sharedGitContextCache,
    });
    if (!gitContext) return null;
    return {
      projectId: gitContext.projectId,
      branch: gitContext.branch,
      rootPath: gitContext.rootPath,
      defaultBranch: gitContext.defaultBranch,
    };
  } catch (error) {
    if (
      options.abortSignal?.aborted ||
      (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs)
    ) {
      throw error;
    }
    return null;
  }
}

/**
 * Attach a coding context to a session (issue #569). Used by the Claude
 * Code / Codex connectors at session start, and by the
 * `remnic.set_coding_context` MCP tool (PR 7).
 */
export interface EngramAccessSetCodingContextRequest {
  sessionKey: string;
  codingContext: {
    projectId: string;
    branch: string | null;
    rootPath: string;
    defaultBranch: string | null;
  } | null;
  /**
   * Transport-bound caller principal — set by the boundary from the resolved
   * request identity, never from the payload. With namespaces enabled the
   * session's derived principal must match (or resolve to `default`), the
   * same binding the extraction force-flush enforces (#3515 review).
   */
  authenticatedPrincipal?: string;
  /**
   * Set by the boundary for caller-supplied roots (#3515 review): marks the
   * stored context's rootPath as remote so daemon surfaces never open it as
   * a local path. Internal resolutions (cwd/projectTag on this host, CLI)
   * leave it unset.
   */
  remote?: boolean;
}

/**
 * The coding-context root as a daemon-local path. A client-resolved (remote)
 * root degrades to the projectId — exactly what a projectTag-derived context
 * already carries — so surfaces behave like today's non-repo contexts instead
 * of scanning a foreign host's path.
 */
export function codingContextLocalRoot(codingContext: CodingContext): string {
  if (codingContext.remote !== true) return codingContext.rootPath;
  // projectId is caller-chosen and may be shaped like a path ("/srv/x"), so a
  // remote root degrades to the tag form — the same non-path label a
  // projectTag-derived context carries — never a daemon-openable location.
  const projectId = codingContext.projectId;
  return projectId.startsWith("tag:") ? projectId : `tag:${projectId}`;
}

/**
 * Validates the input shape and rejects malformed payloads rather than
 * silently accepting them (CLAUDE.md #51). Pass `codingContext: null` to
 * clear. With namespaces enabled, set and clear are bound to the caller's
 * principal so one client cannot rewrite another session's context.
 */
const setCodingContextRequestSchema = z.object({
  sessionKey: z.string().trim().min(1, "sessionKey is required for setCodingContext"),
  codingContext: codingContextSchema,
  authenticatedPrincipal: z.string().optional(),
  remote: z.boolean().optional(),
});

/**
 * True when a caller-supplied root is a git worktree top on THIS host —
 * a directory containing a `.git` entry (dir for a checkout, file for a
 * linked worktree). A same-host pane's client-resolved root verifies and
 * keeps its local path; a genuinely remote or forged path fails closed to
 * the remote marker so surfaces never open it.
 */
function isDaemonRepoRoot(rootPath: string): boolean {
  try {
    return statSync(rootPath).isDirectory() && existsSync(join(rootPath, ".git"));
  } catch {
    return false;
  }
}

export function setSessionCodingContext(
  orchestrator: Orchestrator,
  request: EngramAccessSetCodingContextRequest,
): void {
  const parsed = setCodingContextRequestSchema.safeParse(request);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
      .join("; ");
    throw new EngramAccessInputError(detail || "invalid setCodingContext request");
  }
  const sessionKey = parsed.data.sessionKey;
  // Bind set AND clear to the caller (#3515 review): with namespaces on,
  // the session's derived principal must be the caller (or `default`,
  // i.e. unclaimed — first caller binds), mirroring the extraction
  // force-flush ownership check.
  let claimOwner: string | undefined;
  if (resolveNamespaceCapabilities(orchestrator.config).namespaces === true) {
    const authenticatedPrincipal = parsed.data.authenticatedPrincipal?.trim() || undefined;
    // A live claim outranks the config mapping: the first authenticated
    // writer to an unclaimed session owns it until the context is cleared
    // or the session ends, so another principal cannot take it over later.
    const claimedOwner = orchestrator.getCodingContextOwnerForSession?.(sessionKey);
    const sessionPrincipal = claimedOwner ?? resolvePrincipal(sessionKey, orchestrator.config);
    if (authenticatedPrincipal === undefined) {
      // No transport principal — internal callers (daemon attach, CLI) may
      // write an unclaimed session but never overwrite a claimed one.
      if (sessionPrincipal !== undefined && sessionPrincipal !== "default") {
        throw new EngramAccessInputError("sessionKey is not owned by authenticated principal");
      }
    } else if (sessionPrincipal !== undefined && sessionPrincipal !== "default" && sessionPrincipal !== authenticatedPrincipal) {
      throw new EngramAccessInputError("sessionKey is not owned by authenticated principal");
    } else if (
      authenticatedPrincipal !== "default" && claimedOwner === undefined
      && (sessionPrincipal === undefined || sessionPrincipal === "default")
    ) {
      claimOwner = authenticatedPrincipal;
    }
  }
  const ctx = parsed.data.codingContext;
  if (ctx === null) {
    orchestrator.setCodingContextForSession(sessionKey, null);
    return;
  }
  const stored: CodingContext = {
    projectId: ctx.projectId,
    branch: ctx.branch,
    rootPath: ctx.rootPath,
    defaultBranch: ctx.defaultBranch,
  };
  if (parsed.data.remote === true && !isDaemonRepoRoot(ctx.rootPath)) {
    stored.remote = true;
  }
  orchestrator.setCodingContextForSession(sessionKey, stored, claimOwner);
}
