import { projectTagProjectId } from "./coding/coding-namespace.js";
import { resolveGitContext } from "./coding/git-context.js";
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
