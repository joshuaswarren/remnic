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

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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
  let notes: string;
  try {
    notes = await readFile(planPath, "utf8");
  } catch {
    // No plan file yet is the ordinary case, not a failure.
    return;
  }
  if (notes.trim().length === 0) return;
  await postJson(
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
  // Truncated only AFTER the daemon accepted them, so a failed POST retries on
  // the next flush instead of losing the notes.
  await writeFile(planPath, "", "utf8");
}
