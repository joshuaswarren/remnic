/**
 * Pure rendering for `remnic quarantine list` (issue #1888 part 2): show the
 * writes the namespace ACL rejected and dead-lettered (recoverable) instead of
 * silently destroying them. The store I/O lives in `@remnic/core`; this module
 * is provider-free and unit-testable.
 *
 * The recovery command (`remnic quarantine replay`) is a deliberate follow-up:
 * a correct replay must re-submit without the access layer re-quarantining the
 * replay attempt, which needs a quarantine-suppression flag threaded through
 * the write surface — its own focused change.
 */

import type { QuarantinedRecord } from "@remnic/core/write-quarantine.js";

export type QuarantineFormat = "text" | "json";

export function renderQuarantineList(records: readonly QuarantinedRecord[], format: QuarantineFormat): string {
  if (format === "json") {
    // Project to metadata only — the raw `payload` is the original
    // observe/memory_store request and can carry full user memory text, which
    // must not leak through an operator-facing list command.
    const summary = records.map((record) => ({
      timestamp: record.timestamp,
      operation: record.operation,
      principal: record.principal,
      attemptedNamespace: record.attemptedNamespace,
    }));
    return JSON.stringify(summary, null, 2);
  }
  if (format !== "text") {
    throw new Error(`Unsupported quarantine format: ${String(format)}`);
  }
  if (records.length === 0) return "No quarantined writes.";
  const lines = [`Quarantined writes (${records.length}):`, ""];
  for (const record of records) {
    lines.push(
      `  ${record.timestamp}  ${record.operation}  principal=${record.principal ?? "-"}  attemptedNamespace=${record.attemptedNamespace}`
    );
  }
  return lines.join("\n");
}
