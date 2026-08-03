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
  timeoutMs: number;
}): Promise<void> {
  if (options.workspaceDir === undefined) return;
  const planPath = path.join(
    options.workspaceDir,
    ...buildMemoryFlushPlan({ serviceId: options.serviceId }).relativePath.split("/"),
  );
  // The embedded processor refuses a symlinked plan file or parent, and so must
  // this one: following a link would send another file's contents to the daemon
  // and then truncate that file. `lstat` on every segment under the workspace,
  // never `realpath`, so a link cannot be resolved away before the check.
  if (!(await isLinkFreeUnder(options.workspaceDir, planPath))) {
    log.warn(
      `[${options.serviceId}] flush-plan ingestion skipped: ${planPath} or a parent is a symlink`,
    );
    return;
  }
  let notes: string;
  try {
    notes = await readFile(planPath, "utf8");
  } catch {
    // No plan file yet is the ordinary case, not a failure.
    return;
  }
  if (notes.trim().length === 0) return;
  // Posted in BOUNDED chunks. The daemon rejects a body over `maxBodyBytes`
  // with a 413, and keeping the notes on rejection — which is what stops a
  // credential outage from destroying them — would otherwise deadlock: every
  // later flush would resend the same oversized body and the file could never
  // drain, even once the daemon recovered.
  let sent = "";
  for (const chunk of chunkOnLineBoundaries(notes, MAX_OBSERVE_CHUNK_BYTES)) {
    const accepted = await postJson(
      options.target,
      options.serviceId,
      "/engram/v1/observe",
      {
        sessionKey: options.sessionKey,
        messages: [{ role: "user", content: chunk }],
        ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
      },
      options.timeoutMs,
    );
    // `postJson` resolves to null on 401/403 rather than throwing. Stop here
    // and keep everything not yet accepted, so a rotation or a token without
    // `observe` costs nothing.
    if (accepted === null) {
      log.warn(
        `[${options.serviceId}] flush-plan notes were rejected by the daemon; keeping the remainder for the next flush`,
      );
      break;
    }
    sent += chunk;
  }
  if (sent.length === 0) return;
  // Remove ONLY what was accepted. Another session may have appended between
  // the read and now, and blanking the file would discard notes never sent.
  let current: string;
  try {
    current = await readFile(planPath, "utf8");
  } catch {
    return;
  }
  await writeFile(planPath, current.startsWith(sent) ? current.slice(sent.length) : current, "utf8");
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
