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

import { lstat, readFile, writeFile } from "node:fs/promises";

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
import { postJson } from "./delegate-runtime.js";

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
  let pending = await readPlan(planPath);
  if (pending === undefined || pending.trim().length === 0) return;

  // Chunks start large and HALVE on rejection. The daemon's `maxBodyBytes` is
  // configurable to any positive integer and is not reported anywhere this
  // client can read, so guessing a fixed ceiling would deadlock every daemon
  // configured below it — the very failure chunking was added to end. Adapting
  // needs no new daemon surface and converges in a few requests.
  let chunkBytes = MAX_OBSERVE_CHUNK_BYTES;
  while (pending.trim().length > 0) {
    const timeoutMs = options.remainingTimeoutMs();
    if (timeoutMs <= 0) {
      log.warn(
        `[${options.serviceId}] flush-plan ingestion stopped: the caller's deadline is spent; the remainder drains on the next flush`,
      );
      return;
    }
    const [chunk] = chunkOnLineBoundaries(pending, chunkBytes);
    if (chunk === undefined) return;
    const accepted = await postJson(
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
    if (accepted === null) {
      // Too large, or the credential is not accepted — indistinguishable from
      // here. Halve and retry until a single line is all that is left; below
      // that the daemon is refusing the content itself, not its size.
      if (chunkBytes > MIN_OBSERVE_CHUNK_BYTES && chunkOnLineBoundaries(pending, chunkBytes).length > 1) {
        chunkBytes = Math.max(MIN_OBSERVE_CHUNK_BYTES, Math.floor(chunkBytes / 2));
        continue;
      }
      log.warn(
        `[${options.serviceId}] flush-plan notes were rejected by the daemon; keeping the remainder for the next flush`,
      );
      return;
    }
    // Committed IMMEDIATELY, so a later chunk that throws cannot resend what
    // the daemon already took. Re-reads the file each time, so notes appended
    // by another session in the meantime survive.
    pending = (await commitAcceptedPrefix(planPath, chunk)) ?? "";
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
 * Remove `accepted` from the front of the plan file and return what is left.
 *
 * Only the accepted prefix: another session may have appended between the read
 * and now, and blanking the file would discard notes that were never sent.
 */
async function commitAcceptedPrefix(
  planPath: string,
  accepted: string,
): Promise<string | undefined> {
  const current = await readPlan(planPath);
  if (current === undefined) return undefined;
  const remainder = current.startsWith(accepted) ? current.slice(accepted.length) : current;
  await writeFile(planPath, remainder, "utf8");
  return current.startsWith(accepted) ? remainder : undefined;
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
