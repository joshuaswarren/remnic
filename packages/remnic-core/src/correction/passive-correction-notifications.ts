/**
 * correction/passive-correction-notifications.ts — JSONL notification queue
 * for auto-applied passive corrections (issue #1581).
 *
 * When passive capture auto-applies a correction, it enqueues a one-line
 * notification here: `✎ Memory updated: <summary> (auto-applied (plan <planId>))`.
 * The plan id is referenced (not a revert command) because `remnic correct`
 * has no `--revert` flag — corrections are page-versioned for manual revert.
 * The next session-start briefing drains the queue ONCE (temp-file-then-rename,
 * rule 54) and clears it, so a notification is shown exactly once.
 *
 * File location: `<storageDir>/state/corrections/notifications.jsonl`
 */

import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { serializeMutations } from "../utils/serialize-mutations.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PassiveCorrectionNotification {
  planId: string;
  /** One-line human-readable summary of what changed. */
  summary: string;
  /** Undo command the user can run. */
  undoCommand: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Path
// ---------------------------------------------------------------------------

function notificationsPath(storageDir: string): string {
  return path.join(storageDir, "state", "corrections", "notifications.jsonl");
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

/**
 * Append a notification line to the JSONL queue. Atomic (rule 54): the line
 * is written to a temp file then renamed over the real file. Multiple
 * notifications accumulate across calls — the queue is drained, not replaced.
 */
export async function enqueuePassiveCorrectionNotification(
  storageDir: string,
  notification: PassiveCorrectionNotification,
): Promise<void> {
  const filePath = notificationsPath(storageDir);
  await serializeMutations(`passive-notification:${filePath}`, async () => {
    // Read existing content (if any) so we accumulate rather than overwrite.
    let existing = "";
    try {
      existing = await readFile(filePath, "utf-8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") throw err;
    }

    await mkdir(path.dirname(filePath), { recursive: true });
    const line = `${JSON.stringify(notification)}\n`;
    const content = existing + line;

    const tmp = `${filePath}.${process.pid}.${Date.now().toString(36)}.tmp`;
    await writeFile(tmp, content, "utf-8");
    await rename(tmp, filePath);
  });
}

// ---------------------------------------------------------------------------
// Drain (read + clear — exactly once)
// ---------------------------------------------------------------------------

/**
 * Read all pending notifications and atomically clear the file. Returns the
 * notifications in insertion order. If the file does not exist, returns [].
 *
 * Drain-once semantics: the file is deleted after reading, so calling this
 * twice in a row returns notifications only the first time.
 */
export async function drainPassiveCorrectionNotifications(
  storageDir: string,
): Promise<PassiveCorrectionNotification[]> {
  const filePath = notificationsPath(storageDir);
  return serializeMutations(`passive-notification:${filePath}`, async () => {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return [];
      throw err;
    }

    const notifications: PassiveCorrectionNotification[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        notifications.push(JSON.parse(trimmed) as PassiveCorrectionNotification);
      } catch {
        // Skip malformed lines (rule 34 — best-effort, never crash a briefing).
        continue;
      }
    }

    // Clear the file atomically (delete is atomic enough for this use case —
    // the worst case is a duplicate notification, never a lost one, because
    // the read already captured the content).
    try {
      await unlink(filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") throw err;
    }

    return notifications;
  });
}
