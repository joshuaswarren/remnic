/**
 * Pure logic + rendering for `remnic quarantine list|replay` (issue #1888):
 * surface the writes the namespace ACL rejected and dead-lettered (recoverable)
 * instead of silently destroying them, and re-submit them once the config is
 * fixed. The store I/O lives in `@remnic/core`; this module is provider-free
 * and unit-testable.
 *
 * `replayQuarantine` re-submits each parked payload with `suppressQuarantine`
 * set, so a still-unwritable target propagates the error (recorded as a
 * failure, original left parked) instead of the replay attempt itself being
 * re-quarantined into a duplicate record.
 */

import type { QuarantineOperation, QuarantinedRecord, WriteQuarantineStore } from "@remnic/core/write-quarantine.js";

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

export interface ReplayResult {
  replayed: number;
  failures: Array<{ operation: QuarantineOperation; attemptedNamespace: string; error: string }>;
  deleteFailures: Array<{ path: string; error: string }>;
}

/**
 * Re-submit every parked payload into `targetNamespace`. Each re-submit carries
 * `suppressQuarantine: true`, so a target that is STILL not writable throws
 * instead of re-parking the attempt: that error is recorded as a failure and
 * the original stays parked (never duplicated). An entry is only counted as
 * `replayed` when BOTH the submit AND the follow-up `removeEntry` succeed; a
 * submit that lands but whose record cannot be deleted is a `deleteFailure`
 * (the record remains, so it is not counted). A single failure never aborts the
 * loop — every entry gets its own attempt.
 */
export async function replayQuarantine(opts: {
  store: WriteQuarantineStore;
  targetNamespace: string;
  principal?: string;
  submit: (operation: QuarantineOperation, request: unknown) => Promise<void>;
}): Promise<ReplayResult> {
  const result: ReplayResult = { replayed: 0, failures: [], deleteFailures: [] };
  for (const entry of await opts.store.entries()) {
    const { record } = entry;
    const basePayload = record.payload as Record<string, unknown>;
    const request: Record<string, unknown> = {
      ...basePayload,
      namespace: opts.targetNamespace,
      suppressQuarantine: true,
      ...(opts.principal ? { authenticatedPrincipal: opts.principal } : {}),
    };
    try {
      await opts.submit(record.operation, request);
    } catch (err) {
      result.failures.push({
        operation: record.operation,
        attemptedNamespace: opts.targetNamespace,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    try {
      const removed = await opts.store.removeEntry(entry.path);
      if (removed) {
        result.replayed += 1;
      } else {
        result.deleteFailures.push({
          path: entry.path,
          error: "entry not removed (outside quarantine root or already absent)",
        });
      }
    } catch (err) {
      result.deleteFailures.push({
        path: entry.path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

export function renderReplayResult(result: ReplayResult, targetNamespace: string, format: QuarantineFormat): string {
  if (format === "json") {
    return JSON.stringify(
      {
        targetNamespace,
        replayed: result.replayed,
        failures: result.failures,
        deleteFailures: result.deleteFailures,
      },
      null,
      2
    );
  }
  if (format !== "text") {
    throw new Error(`Unsupported quarantine format: ${String(format)}`);
  }
  const lines = [`Replayed ${result.replayed} quarantined write(s) into namespace ${targetNamespace}.`];
  if (result.failures.length > 0) {
    lines.push("", `Failures (${result.failures.length}); left parked:`);
    for (const failure of result.failures) {
      lines.push(`  ${failure.operation}  attemptedNamespace=${failure.attemptedNamespace}  error=${failure.error}`);
    }
  }
  if (result.deleteFailures.length > 0) {
    lines.push("", `Delete failures (${result.deleteFailures.length}); re-submitted but still parked:`);
    for (const del of result.deleteFailures) {
      lines.push(`  ${del.path}  error=${del.error}`);
    }
  }
  return lines.join("\n");
}
