/**
 * Pure vault publish dry-run planner (issue #1985).
 *
 * `planVaultDryRun` predicts per-note publish outcomes from text the caller
 * has already read. It takes strings, not paths, and returns only a report:
 * zero writes is a property of the signature, not a promise. Reporting a
 * note as `updated` when `currentText` is null describes the create a real
 * publish WOULD do; nothing is created here.
 *
 * Internal helper: nothing calls it yet. CLI/HTTP wiring for the `--dry-run`
 * flag is a later slice of #1985.
 */
import { summarizeVaultPublish } from "./vault-status.js";
import type { VaultPublishOutcome, VaultPublishResult, VaultPublishStatus } from "./vault-status.js";

export interface VaultDryRunInput {
  /** Vault-relative note path, for reporting only. */
  path: string;
  /** Current note text, or null when the note does not exist. */
  currentText: string | null;
  /** The text a real publish would produce, or null when it would skip. */
  nextText: string | null;
  /** Required when nextText is null: why the publish would skip. */
  skipReason?: string;
}

export function planVaultDryRun(inputs: readonly VaultDryRunInput[]): VaultPublishStatus {
  const results: VaultPublishResult[] = [];
  for (const input of inputs) {
    if (typeof input !== "object" || input === null) {
      throw new TypeError(`vault dry-run inputs must be objects (got ${typeof input})`);
    }
    if (typeof input.path !== "string" || input.path.trim() === "") {
      throw new RangeError(`vault dry-run input requires a non-blank path (got ${JSON.stringify(input.path)})`);
    }
    if (input.nextText === null) {
      if (typeof input.skipReason !== "string" || input.skipReason.trim() === "") {
        throw new TypeError(
          `vault dry-run skip (nextText null) requires a non-blank skipReason (got ${JSON.stringify(input.skipReason)})`,
        );
      }
      results.push({ path: input.path, outcome: "skipped", reason: input.skipReason });
      continue;
    }
    if (input.skipReason !== undefined) {
      throw new TypeError(
        `vault dry-run skipReason is only valid when nextText is null (path ${JSON.stringify(input.path)})`,
      );
    }
    // A missing note is NOT a create: the real publisher (vault-publish.ts
    // publishVaultRegion) refuses to create missing files and returns
    // missing_file, so the dry run must predict that skip rather than promise
    // an update the real run will not perform.
    if (input.currentText === null) {
      results.push({ path: input.path, outcome: "skipped", reason: "missing_file" });
      continue;
    }
    // Byte-exact compare: a publish that rewrites only trailing whitespace is
    // still a write.
    const outcome: VaultPublishOutcome = input.currentText === input.nextText ? "unchanged" : "updated";
    results.push({ path: input.path, outcome });
  }
  return summarizeVaultPublish(results);
}
