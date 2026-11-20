/**
 * Client-side coding context sync (#3515). The daemon's server-side
 * `resolveGitContext(cwd)` runs git on ITS filesystem — a remote pane's cwd
 * usually does not exist there, so resolution silently fails and the session
 * lands in the default overlay. The pane host has the real cwd, so it resolves
 * locally and posts the result through `POST /engram/v1/coding-context`.
 * Server-side cwd resolution remains the fallback for same-host daemons.
 */
import { probeGitContext, type GitContext, type GitContextProbeResult } from "@remnic/core/coding/git-context";

import type { SetCodingContextResponse } from "./client.js";

export interface CodingContextCarrier {
  setCodingContext(sessionKey: string, codingContext: GitContext | null): Promise<SetCodingContextResponse>;
}

export interface CodingContextSyncState {
  /** Signature of the last context the daemon accepted; null = nothing posted. */
  lastCodingContextSignature: string | null;
  /**
   * Set when a sync observed the daemon unreachable: a restart there wipes the
   * per-session context map, so the latched signature may no longer be true.
   * The next reachable sync clears the latch and re-posts the current context.
   */
  codingContextRepostPending: boolean;
  /** In-flight/queued sync — serializes posts so the newest resolution always lands last. */
  codingContextSyncChain?: Promise<void>;
}

export interface SyncCodingContextOptions {
  sessionKey: string;
  cwd: string;
  state: CodingContextSyncState;
  client: CodingContextCarrier;
  /** Injectable for tests; defaults to the shared core probe. */
  resolve?: (cwd: string) => Promise<GitContextProbeResult>;
}

export interface CodingContextSyncCtx {
  session: { sessionKey: string; cwd: string };
  state: CodingContextSyncState & { startupEpoch?: number };
  client: CodingContextCarrier & { isReachable(): boolean };
  config: { authToken?: string };
  /** Injectable for tests; defaults to the shared core probe. */
  resolve?: (cwd: string) => Promise<GitContextProbeResult>;
}

/** Per-turn refresh: re-resolve off the turn path and post only on change. */
export async function maybeSyncSessionCodingContext(ctx: CodingContextSyncCtx): Promise<void> {
  if (!ctx.config.authToken) return;
  if (!ctx.client.isReachable()) {
    ctx.state.codingContextRepostPending = true;
    return;
  }
  if (ctx.state.codingContextRepostPending) {
    ctx.state.lastCodingContextSignature = null;
    ctx.state.codingContextRepostPending = false;
  }
  // Serialize per session (wAK review): a slower earlier sync must never post
  // after a newer one. Each queued run resolves fresh, so the last post the
  // daemon sees always carries the newest resolution.
  const run = (ctx.state.codingContextSyncChain ?? Promise.resolve()).then(() =>
    syncSessionCodingContext({
      sessionKey: ctx.session.sessionKey,
      cwd: ctx.session.cwd,
      state: ctx.state,
      client: ctx.client,
      resolve: ctx.resolve,
    }),
  );
  ctx.state.codingContextSyncChain = run;
  await run;
}

/**
 * Chain the session-start sync behind the startup probe so the post lands
 * before the first observe when the host is fast. `epoch` lets a stale probe
 * chain (a newer session_start bumped state.startupEpoch) skip its post.
 */
export function attachCodingContextSync<T>(
  probe: Promise<T>,
  ctx: CodingContextSyncCtx & { epoch: number },
): Promise<T> {
  return probe.then(async (result) => {
    if (ctx.state.startupEpoch === undefined || ctx.state.startupEpoch === ctx.epoch) {
      await maybeSyncSessionCodingContext(ctx);
    }
    return result;
  });
}

function signature(ctx: GitContext): string {
  return `${ctx.projectId}\n${ctx.branch}\n${ctx.rootPath}\n${ctx.defaultBranch}`;
}

/**
 * Resolve the session's git context locally and POST it only when it changed
 * since the last accepted post. A `null` resolution clears a previously posted
 * context (the cwd left its repo); nothing is posted when there was never a
 * context to clear. A failed post leaves the signature unlatched so the next
 * sync retries. Never throws — context sync is best-effort beside the turn path.
 */
export async function syncSessionCodingContext(options: SyncCodingContextOptions): Promise<void> {
  const { sessionKey, cwd, state, client } = options;
  const resolve = options.resolve ?? ((dir: string) => probeGitContext(dir));
  let resolved: GitContext | null;
  try {
    const probe = await resolve(cwd);
    if (!probe.conclusive) {
      return; // probe failed or degraded (timeout/spawn) — keep the posted binding, retry next sync
    }
    resolved = probe.context;
  } catch {
    return; // inconclusive resolution is not "no repo" — retry next sync
  }
  const next = resolved === null ? null : signature(resolved);
  if (next === state.lastCodingContextSignature) return;
  try {
    await client.setCodingContext(sessionKey, resolved);
    state.lastCodingContextSignature = next;
  } catch {
    // leave the signature stale so the next turn retries
  }
}
