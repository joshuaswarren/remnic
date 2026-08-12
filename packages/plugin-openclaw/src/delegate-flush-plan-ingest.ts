/**
 * Hand the host's flush-plan notes to the daemon, then clear the file.
 *
 * The delegate capability advertises a flush plan, so OpenClaw appends durable
 * notes to `state/plugins/<serviceId>/flush-plan.md` in the GATEWAY's
 * workspace. Embedded mode ingests that file from its own registration path;
 * delegate mode returns before any of that wiring, and the daemon cannot see a
 * gateway-local file — so without this the notes the host was told to write
 * are read by nobody.
 */

import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";

/**
 * Bytes per observe request. Comfortably under the daemon's default
 * `maxBodyBytes` (131072) so the JSON envelope around the notes still fits.
 */
const MAX_OBSERVE_CHUNK_BYTES = 96 * 1024;
/** The floor the adaptive halving stops at — below this a single note. */
const MIN_OBSERVE_CHUNK_BYTES = 4 * 1024;
import path from "node:path";

import { log } from "@remnic/core/logger";

import type { DelegateDaemonTarget } from "./bridge.js";
import { buildMemoryFlushPlan } from "./memory-flush-plan.js";
import { postJsonWithStatus } from "./delegate-http.js";

export async function ingestFlushPlanNotes(options: {
  target: DelegateDaemonTarget;
  serviceId: string;
  workspaceDir: string | undefined;
  sessionKey: string;
  namespace: string | undefined;
  /** What is LEFT of the caller's deadline, re-read for every chunk. */
  remainingTimeoutMs: () => number;
}): Promise<void> {
  if (options.workspaceDir === undefined) return;
  const planPath = path.join(
    options.workspaceDir,
    ...buildMemoryFlushPlan({ serviceId: options.serviceId }).relativePath.split("/"),
  );
  // The embedded processor refuses a symlinked plan file or parent, and so must
  // this one: following a link would send another file's contents to the daemon
  // and then truncate that file. `lstat` on the ROOT and every segment below
  // it, never `realpath`, so a link cannot be resolved away before the check.
  if (!(await isLinkFreeUnder(options.workspaceDir, planPath))) {
    log.warn(
      `[${options.serviceId}] flush-plan ingestion skipped: ${planPath}, a parent, or the workspace root is a symlink`,
    );
    return;
  }

  // Claim the notes by RENAME before posting anything (issue #2303). Rename is
  // atomic, so every host append after it lands in a freshly created plan file
  // and cannot be truncated away by our commit. The alternative — re-reading
  // the shared file and rewriting it minus the accepted prefix — loses any
  // append that arrives inside that read/write window.
  const inflightPath = `${planPath}.inflight`;
  // Chunks start large and HALVE on a body-limit rejection. The daemon's
  // `maxBodyBytes` is configurable to any positive integer and is not reported
  // anywhere this client can read, so guessing a fixed ceiling would deadlock
  // every daemon configured below it — the very failure chunking was added to
  // end. Adapting needs no new daemon surface and converges in a few requests.
  let chunkBytes = MAX_OBSERVE_CHUNK_BYTES;
  // Re-claim after each drained snapshot so notes the host appended WHILE we
  // were posting still leave in this flush. Every pass needs budget and needs
  // the host to have written something new, so this terminates.
  for (;;) {
    if (options.remainingTimeoutMs() <= 0) return;
    const claimed = await claimPendingNotes(planPath, inflightPath, options.serviceId);
    if (claimed === undefined || claimed.trim().length === 0) {
      await discardInflight(inflightPath);
      return;
    }
    let pending = claimed;
    let stop = false;
    try {
      while (pending.trim().length > 0) {
        const timeoutMs = options.remainingTimeoutMs();
        if (timeoutMs <= 0) {
          log.warn(
            `[${options.serviceId}] flush-plan ingestion stopped: the caller's deadline is spent; the remainder drains on the next flush`,
          );
          stop = true;
          return;
        }
        const [chunk] = chunkOnLineBoundaries(pending, chunkBytes);
        if (chunk === undefined) {
          stop = true;
          return;
        }
        const response = await postJsonWithStatus(
          options.target,
          options.serviceId,
          "/engram/v1/observe",
          {
            sessionKey: options.sessionKey,
            messages: [{ role: "user", content: chunk }],
            ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
          },
          timeoutMs,
        );
        if (response.status === 401 || response.status === 403) {
          // Halving cannot fix a refused credential. Stopping here also stops
          // the pointless retry ladder the old collapsed-to-null contract ran.
          log.warn(
            `[${options.serviceId}] flush-plan notes were refused by the daemon (${response.status}); keeping them for the next flush`,
          );
          stop = true;
          return;
        }
        if (isBodyTooLarge(response.status)) {
          // Halve whenever a smaller ceiling is still available. Requiring
          // the CURRENT ceiling to already split the text was wrong: a
          // 40 KiB plan under a 96 KiB ceiling is one chunk, so a daemon
          // configured below 40 KiB rejected it forever — the deadlock
          // chunking exists to end.
          if (chunkBytes > MIN_OBSERVE_CHUNK_BYTES) {
            chunkBytes = Math.max(MIN_OBSERVE_CHUNK_BYTES, Math.floor(chunkBytes / 2));
            continue;
          }
          log.warn(
            `[${options.serviceId}] a flush-plan note exceeds the daemon's body limit even at the minimum chunk size; keeping the remainder for the next flush`,
          );
          stop = true;
          return;
        }
        if (response.status < 200 || response.status > 299) {
          stop = true;
          throw new Error(`daemon /engram/v1/observe responded ${response.status}`);
        }
        // Committed IMMEDIATELY, so a later chunk that throws cannot resend
        // what the daemon already took. The inflight file has no other writer,
        // so this rewrite cannot lose a concurrent append.
        pending = pending.slice(chunk.length);
        await writeFile(inflightPath, pending, "utf8");
      }
    } finally {
      // Whatever is left goes back in FRONT of any note appended while we were
      // posting, so the daemon still receives them in the order written.
      await releasePendingNotes(planPath, inflightPath, pending, options.serviceId);
    }
    if (stop) return;
  }
}

/** HTTP statuses that mean "the request body was too big for this daemon". */
function isBodyTooLarge(status: number): boolean {
  return status === 413 || status === 431;
}

/**
 * Take ownership of the plan file's contents.
 *
 * Recovers an inflight snapshot left by a crashed run first, so its notes are
 * never stranded, then renames the live plan aside. Returns everything now
 * owned by this run, oldest note first.
 */
async function claimPendingNotes(
  planPath: string,
  inflightPath: string,
  serviceId: string,
): Promise<string | undefined> {
  const orphaned = (await readPlan(inflightPath)) ?? "";
  if (orphaned.length > 0) {
    log.warn(
      `[${serviceId}] recovering flush-plan notes left by an interrupted ingestion`,
    );
  }
  try {
    await rename(planPath, `${inflightPath}.rotating`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    return orphaned.length > 0 ? orphaned : undefined;
  }
  const rotated = (await readPlan(`${inflightPath}.rotating`)) ?? "";
  await discardInflight(`${inflightPath}.rotating`);
  const pending = `${orphaned}${rotated}`;
  if (pending.length === 0) return undefined;
  await writeFile(inflightPath, pending, "utf8");
  return pending;
}

/**
 * Put unsent notes back at the head of the plan file and drop the snapshot.
 *
 * A failure here must not mask the error that ended the run, so it only warns:
 * the inflight file survives and the next run recovers from it.
 */
async function releasePendingNotes(
  planPath: string,
  inflightPath: string,
  pending: string,
  serviceId: string,
): Promise<void> {
  try {
    if (pending.length === 0) {
      await discardInflight(inflightPath);
      return;
    }
    const appended = (await readPlan(planPath)) ?? "";
    await writeFile(planPath, `${pending}${appended}`, "utf8");
    await discardInflight(inflightPath);
  } catch (err) {
    log.warn(
      `[${serviceId}] could not restore unsent flush-plan notes; the next ingestion recovers them: ${String(err)}`,
    );
  }
}

/** Remove a snapshot file, tolerating one that is already gone. */
async function discardInflight(inflightPath: string): Promise<void> {
  try {
    await unlink(inflightPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}

/** The plan file's contents, or `undefined` when it does not exist. */
async function readPlan(planPath: string): Promise<string | undefined> {
  try {
    return await readFile(planPath, "utf8");
  } catch {
    // No plan file yet is the ordinary case, not a failure.
    return undefined;
  }
}

/**
 * Split on line boundaries, each piece under `limit` BYTES.
 *
 * Line-aligned so a note is never cut mid-sentence. A single line longer than
 * the limit is emitted whole rather than mangled — it would be rejected, and
 * the caller keeps it, which is the honest outcome for a note that cannot fit.
 */
function chunkOnLineBoundaries(text: string, limit: number): string[] {
  if (Buffer.byteLength(text, "utf8") <= limit) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split(/(?<=\n)/)) {
    if (current !== "" && Buffer.byteLength(current + line, "utf8") > limit) {
      chunks.push(current);
      current = "";
    }
    current += line;
  }
  if (current !== "") chunks.push(current);
  return chunks;
}

/**
 * Whether `target` and every directory between it and `root` is link-free.
 *
 * `lstat` per segment rather than a `realpath` comparison: resolving first
 * would answer for the LINK's destination, which is the thing being guarded
 * against.
 */
async function isLinkFreeUnder(root: string, target: string): Promise<boolean> {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  let current = root;
  // The ROOT first: a replaceable workspace symlink would otherwise be walked
  // straight through, which is the same escape the per-segment check exists to
  // stop — one level up.
  try {
    if ((await lstat(current)).isSymbolicLink()) return false;
  } catch {
    return true;
  }
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) return false;
    } catch {
      // A segment that does not exist yet cannot be a link.
      return true;
    }
  }
  return true;
}
