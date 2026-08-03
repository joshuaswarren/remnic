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
  const accepted = await postJson(
    options.target,
    options.serviceId,
    "/engram/v1/observe",
    {
      sessionKey: options.sessionKey,
      messages: [{ role: "user", content: notes }],
      ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
    },
    options.timeoutMs,
  );
  // `postJson` resolves to null on 401/403 rather than throwing. Truncating on
  // that would delete notes the daemon never took — exactly what happens during
  // a credential rotation, or when the token lacks `observe`.
  if (accepted === null) {
    log.warn(
      `[${options.serviceId}] flush-plan notes were rejected by the daemon; keeping them for the next flush`,
    );
    return;
  }
  // Remove ONLY what was sent. Another session may have appended between the
  // read and now, and blanking the file would discard notes that were never
  // submitted.
  let current: string;
  try {
    current = await readFile(planPath, "utf8");
  } catch {
    return;
  }
  await writeFile(planPath, current.startsWith(notes) ? current.slice(notes.length) : current, "utf8");
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
