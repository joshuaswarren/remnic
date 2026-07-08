/**
 * Creation-memory ledger command group — extracted from cli.ts (#1532 Phase B).
 *
 * Ten creation-memory ledger commands — thin wrappers over exported
 * runXxxCliCommand helpers across three ledgers:
 *   - resume-bundle (status / record / build)
 *   - commitment    (status / record / set-state / lifecycle)
 *   - work-product  (status / record / recall-search)
 *
 * Behaviour is identical to the inline registration it replaces — the
 * cli-command-surface contract tests guard against silent drift.
 *
 * Circular import note: same safe pattern as research-status-commands.ts —
 * the runXxx helpers are referenced only inside action callbacks invoked at
 * runtime, never at module-eval time.
 */

import type { Orchestrator } from "../orchestrator.js";
import type { CliCommand } from "../cli.js";
import type { CommitmentLedgerEntry } from "../commitment-ledger.js";
import type { WorkProductLedgerEntry } from "../work-product-ledger.js";
import type { ResumeBundle } from "../resume-bundles.js";
import { resolveCreationMemoryCapabilities, resolveObjectiveStateCapabilities} from "../capabilities.js";
import {
  runResumeBundleStatusCliCommand,
  runResumeBundleRecordCliCommand,
  runResumeBundleBuildCliCommand,
  runCommitmentStatusCliCommand,
  runCommitmentRecordCliCommand,
  runCommitmentSetStateCliCommand,
  runCommitmentLifecycleCliCommand,
  runWorkProductStatusCliCommand,
  runWorkProductRecordCliCommand,
  runWorkProductRecallSearchCliCommand,
} from "../cli.js";

/**
 * Register the creation-memory ledger command group on the parent `engram`
 * command. Extracted verbatim from registerCli; behaviour-preserving.
 */
export function registerCreationLedgerCommands(
  cmd: CliCommand,
  orchestrator: Orchestrator,
): void {
cmd
  .command("resume-bundle-status")
  .description("Show resume bundle status, bundle counts, and the latest recorded handoff bundle")
  .action(async () => {
    const status = await runResumeBundleStatusCliCommand({
      memoryDir: orchestrator.config.memoryDir,
      resumeBundleDir: orchestrator.config.resumeBundleDir,
      creationMemoryEnabled: resolveCreationMemoryCapabilities(orchestrator.config).creationMemory,
      resumeBundlesEnabled: resolveCreationMemoryCapabilities(orchestrator.config).resumeBundles,
    });
    console.log(JSON.stringify(status, null, 2));
    console.log("OK");
  });

cmd
  .command("resume-bundle-record")
  .description("Record an explicit resume bundle when creation-memory handoff bundles are enabled")
  .requiredOption("--bundle-id <bundleId>", "Resume bundle id")
  .requiredOption("--recorded-at <recordedAt>", "ISO timestamp for the bundle")
  .requiredOption("--session-key <sessionKey>", "Session key that owns the bundle")
  .requiredOption("--source <source>", "Bundle source (tool_result|cli|system|manual)")
  .requiredOption("--scope <scope>", "Primary scope or recovery domain for the bundle")
  .requiredOption("--summary <summary>", "Human-readable summary of what this bundle preserves")
  .option("--key-fact <keyFact...>", "Short facts that a resumed agent should retain")
  .option("--next-action <nextAction...>", "Explicit next actions for the resumed agent")
  .option("--risk-flag <riskFlag...>", "Open risks or cautions attached to the bundle")
  .option(
    "--objective-state-snapshot-ref <objectiveStateSnapshotRef...>",
    "Objective-state snapshot refs attached to the bundle",
  )
  .option(
    "--work-product-entry-ref <workProductEntryRef...>",
    "Work-product ledger refs attached to the bundle",
  )
  .option(
    "--commitment-entry-ref <commitmentEntryRef...>",
    "Commitment ledger refs attached to the bundle",
  )
  .action(async (...args: unknown[]) => {
    const options = (args[0] ?? {}) as Record<string, unknown>;
    const filePath = await runResumeBundleRecordCliCommand({
      memoryDir: orchestrator.config.memoryDir,
      resumeBundleDir: orchestrator.config.resumeBundleDir,
      creationMemoryEnabled: resolveCreationMemoryCapabilities(orchestrator.config).creationMemory,
      resumeBundlesEnabled: resolveCreationMemoryCapabilities(orchestrator.config).resumeBundles,
      bundle: {
        schemaVersion: 1,
        bundleId: String(options.bundleId ?? ""),
        recordedAt: String(options.recordedAt ?? ""),
        sessionKey: String(options.sessionKey ?? ""),
        source: String(options.source ?? "") as ResumeBundle["source"],
        scope: String(options.scope ?? ""),
        summary: String(options.summary ?? ""),
        keyFacts: Array.isArray(options.keyFact) ? options.keyFact.map(String) : undefined,
        nextActions: Array.isArray(options.nextAction) ? options.nextAction.map(String) : undefined,
        riskFlags: Array.isArray(options.riskFlag) ? options.riskFlag.map(String) : undefined,
        objectiveStateSnapshotRefs: Array.isArray(options.objectiveStateSnapshotRef)
          ? options.objectiveStateSnapshotRef.map(String)
          : undefined,
        workProductEntryRefs: Array.isArray(options.workProductEntryRef)
          ? options.workProductEntryRef.map(String)
          : undefined,
        commitmentEntryRefs: Array.isArray(options.commitmentEntryRef)
          ? options.commitmentEntryRef.map(String)
          : undefined,
      },
    });
    console.log(JSON.stringify({ wrote: filePath !== null, filePath }, null, 2));
    console.log("OK");
  });

cmd
  .command("resume-bundle-build")
  .description("Build and persist a resume bundle from transcript recovery, objective state, work products, and open commitments")
  .requiredOption("--bundle-id <bundleId>", "Resume bundle id")
  .requiredOption("--recorded-at <recordedAt>", "ISO timestamp for the bundle")
  .requiredOption("--session-key <sessionKey>", "Session key that owns the bundle")
  .requiredOption("--scope <scope>", "Primary scope or recovery domain for the bundle")
  .action(async (...args: unknown[]) => {
    const options = (args[0] ?? {}) as Record<string, unknown>;
    const built = await runResumeBundleBuildCliCommand({
      memoryDir: orchestrator.config.memoryDir,
      resumeBundleDir: orchestrator.config.resumeBundleDir,
      objectiveStateStoreDir: orchestrator.config.objectiveStateStoreDir,
      workProductLedgerDir: orchestrator.config.workProductLedgerDir,
      commitmentLedgerDir: orchestrator.config.commitmentLedgerDir,
      creationMemoryEnabled: resolveCreationMemoryCapabilities(orchestrator.config).creationMemory,
      resumeBundlesEnabled: resolveCreationMemoryCapabilities(orchestrator.config).resumeBundles,
      transcriptEnabled: orchestrator.config.transcriptEnabled,
      objectiveStateMemoryEnabled: resolveObjectiveStateCapabilities(orchestrator.config).objectiveStateMemory,
      commitmentLedgerEnabled: resolveCreationMemoryCapabilities(orchestrator.config).commitmentLedger,
      bundleId: String(options.bundleId ?? ""),
      recordedAt: String(options.recordedAt ?? ""),
      sessionKey: String(options.sessionKey ?? ""),
      scope: String(options.scope ?? ""),
    });
    console.log(JSON.stringify({
      wrote: built !== null,
      filePath: built?.filePath ?? null,
      bundle: built?.bundle ?? null,
    }, null, 2));
    console.log("OK");
  });

cmd
  .command("commitment-status")
  .description("Show commitment ledger status, entry counts, and the latest recorded commitment")
  .action(async () => {
    const status = await runCommitmentStatusCliCommand({
      memoryDir: orchestrator.config.memoryDir,
      commitmentLedgerDir: orchestrator.config.commitmentLedgerDir,
      creationMemoryEnabled: resolveCreationMemoryCapabilities(orchestrator.config).creationMemory,
      commitmentLedgerEnabled: resolveCreationMemoryCapabilities(orchestrator.config).commitmentLedger,
      commitmentLifecycleEnabled: resolveCreationMemoryCapabilities(orchestrator.config).commitmentLifecycle,
      commitmentStaleDays: orchestrator.config.commitmentStaleDays,
      commitmentDecayDays: orchestrator.config.commitmentDecayDays,
    });
    console.log(JSON.stringify(status, null, 2));
    console.log("OK");
  });

cmd
  .command("commitment-record")
  .description("Record a commitment ledger entry when commitment memory is enabled")
  .requiredOption("--entry-id <entryId>", "Commitment entry id")
  .requiredOption("--recorded-at <recordedAt>", "ISO timestamp for the entry")
  .requiredOption("--session-key <sessionKey>", "Session key that owns the commitment")
  .requiredOption("--source <source>", "Entry source (tool_result|cli|system|manual)")
  .requiredOption("--kind <kind>", "Entry kind (promise|follow_up|deadline|deliverable)")
  .requiredOption("--state <state>", "Entry state (open|fulfilled|cancelled|expired)")
  .requiredOption("--scope <scope>", "Primary scope or identifier for the commitment")
  .requiredOption("--summary <summary>", "Human-readable summary of the commitment")
  .option("--due-at <dueAt>", "Optional due timestamp for the commitment")
  .option("--tag <tag...>", "Tags to attach to the commitment entry")
  .option("--entity-ref <entityRef...>", "Entity refs to attach to the commitment entry")
  .option(
    "--work-product-entry-ref <workProductEntryRef...>",
    "Work-product ledger refs that this commitment depends on",
  )
  .option(
    "--objective-state-snapshot-ref <objectiveStateSnapshotRef...>",
    "Objective-state snapshot refs to link to this commitment",
  )
  .action(async (...args: unknown[]) => {
    const options = (args[0] ?? {}) as Record<string, unknown>;
    const filePath = await runCommitmentRecordCliCommand({
      memoryDir: orchestrator.config.memoryDir,
      commitmentLedgerDir: orchestrator.config.commitmentLedgerDir,
      creationMemoryEnabled: resolveCreationMemoryCapabilities(orchestrator.config).creationMemory,
      commitmentLedgerEnabled: resolveCreationMemoryCapabilities(orchestrator.config).commitmentLedger,
      entry: {
        schemaVersion: 1,
        entryId: String(options.entryId ?? ""),
        recordedAt: String(options.recordedAt ?? ""),
        sessionKey: String(options.sessionKey ?? ""),
        source: String(options.source ?? "") as CommitmentLedgerEntry["source"],
        kind: String(options.kind ?? "") as CommitmentLedgerEntry["kind"],
        state: String(options.state ?? "") as CommitmentLedgerEntry["state"],
        scope: String(options.scope ?? ""),
        summary: String(options.summary ?? ""),
        dueAt: typeof options.dueAt === "string" ? options.dueAt : undefined,
        tags: Array.isArray(options.tag) ? options.tag.map(String) : undefined,
        entityRefs: Array.isArray(options.entityRef) ? options.entityRef.map(String) : undefined,
        workProductEntryRefs: Array.isArray(options.workProductEntryRef)
          ? options.workProductEntryRef.map(String)
          : undefined,
        objectiveStateSnapshotRefs: Array.isArray(options.objectiveStateSnapshotRef)
          ? options.objectiveStateSnapshotRef.map(String)
          : undefined,
      },
    });
    console.log(JSON.stringify({ wrote: filePath !== null, filePath }, null, 2));
    console.log("OK");
  });

cmd
  .command("commitment-set-state")
  .description("Transition an existing commitment ledger entry when commitment lifecycle is enabled")
  .requiredOption("--entry-id <entryId>", "Commitment entry id")
  .requiredOption("--state <state>", "Next state (open|fulfilled|cancelled|expired)")
  .requiredOption("--changed-at <changedAt>", "ISO timestamp for the lifecycle transition")
  .action(async (...args: unknown[]) => {
    const options = (args[0] ?? {}) as Record<string, unknown>;
    const entry = await runCommitmentSetStateCliCommand({
      memoryDir: orchestrator.config.memoryDir,
      commitmentLedgerDir: orchestrator.config.commitmentLedgerDir,
      creationMemoryEnabled: resolveCreationMemoryCapabilities(orchestrator.config).creationMemory,
      commitmentLedgerEnabled: resolveCreationMemoryCapabilities(orchestrator.config).commitmentLedger,
      commitmentLifecycleEnabled: resolveCreationMemoryCapabilities(orchestrator.config).commitmentLifecycle,
      entryId: String(options.entryId ?? ""),
      nextState: String(options.state ?? "") as CommitmentLedgerEntry["state"],
      changedAt: String(options.changedAt ?? ""),
    });
    console.log(JSON.stringify({ updated: entry !== null, entry }, null, 2));
    console.log("OK");
  });

cmd
  .command("commitment-lifecycle-run")
  .description("Apply overdue-expiry and resolved-entry cleanup to the commitment ledger")
  .option("--now <now>", "Override the lifecycle timestamp for testing or backfills")
  .action(async (...args: unknown[]) => {
    const options = (args[0] ?? {}) as Record<string, unknown>;
    const result = await runCommitmentLifecycleCliCommand({
      memoryDir: orchestrator.config.memoryDir,
      commitmentLedgerDir: orchestrator.config.commitmentLedgerDir,
      creationMemoryEnabled: resolveCreationMemoryCapabilities(orchestrator.config).creationMemory,
      commitmentLedgerEnabled: resolveCreationMemoryCapabilities(orchestrator.config).commitmentLedger,
      commitmentLifecycleEnabled: resolveCreationMemoryCapabilities(orchestrator.config).commitmentLifecycle,
      commitmentDecayDays: orchestrator.config.commitmentDecayDays,
      now: typeof options.now === "string" ? options.now : undefined,
    });
    console.log(JSON.stringify({ applied: result !== null, result }, null, 2));
    console.log("OK");
  });

cmd
  .command("work-product-status")
  .description("Show work-product ledger status, entry counts, and the latest recorded work product")
  .action(async () => {
    const status = await runWorkProductStatusCliCommand({
      memoryDir: orchestrator.config.memoryDir,
      workProductLedgerDir: orchestrator.config.workProductLedgerDir,
      creationMemoryEnabled: resolveCreationMemoryCapabilities(orchestrator.config).creationMemory,
    });
    console.log(JSON.stringify(status, null, 2));
    console.log("OK");
  });

cmd
  .command("work-product-record")
  .description("Record a work-product ledger entry when creation-memory is enabled")
  .requiredOption("--entry-id <entryId>", "Ledger entry id")
  .requiredOption("--recorded-at <recordedAt>", "ISO timestamp for the entry")
  .requiredOption("--session-key <sessionKey>", "Session key that created the work product")
  .requiredOption("--source <source>", "Entry source (tool_result|cli|system|manual)")
  .requiredOption("--kind <kind>", "Entry kind (artifact|file|record|report|workspace)")
  .requiredOption(
    "--entry-action <entryAction>",
    "Entry action (created|updated|deleted|referenced|published)",
  )
  .requiredOption("--scope <scope>", "Primary scope or identifier for the created work product")
  .requiredOption("--summary <summary>", "Human-readable summary of the work product")
  .option("--artifact-path <artifactPath>", "Optional path to the created artifact")
  .option("--tag <tag...>", "Tags to attach to the work-product entry")
  .option("--entity-ref <entityRef...>", "Entity refs to attach to the work-product entry")
  .option(
    "--objective-state-snapshot-ref <objectiveStateSnapshotRef...>",
    "Objective-state snapshot refs to link to this work product",
  )
  .action(async (...args: unknown[]) => {
    const options = (args[0] ?? {}) as Record<string, unknown>;
    const filePath = await runWorkProductRecordCliCommand({
      memoryDir: orchestrator.config.memoryDir,
      workProductLedgerDir: orchestrator.config.workProductLedgerDir,
      creationMemoryEnabled: resolveCreationMemoryCapabilities(orchestrator.config).creationMemory,
      entry: {
        schemaVersion: 1,
        entryId: String(options.entryId ?? ""),
        recordedAt: String(options.recordedAt ?? ""),
        sessionKey: String(options.sessionKey ?? ""),
        source: String(options.source ?? "") as WorkProductLedgerEntry["source"],
        kind: String(options.kind ?? "") as WorkProductLedgerEntry["kind"],
        action: String(options.entryAction ?? "") as WorkProductLedgerEntry["action"],
        scope: String(options.scope ?? ""),
        summary: String(options.summary ?? ""),
        artifactPath: typeof options.artifactPath === "string" ? options.artifactPath : undefined,
        tags: Array.isArray(options.tag) ? options.tag.map(String) : undefined,
        entityRefs: Array.isArray(options.entityRef) ? options.entityRef.map(String) : undefined,
        objectiveStateSnapshotRefs: Array.isArray(options.objectiveStateSnapshotRef)
          ? options.objectiveStateSnapshotRef.map(String)
          : undefined,
      },
    });
    console.log(JSON.stringify({ wrote: filePath !== null, filePath }, null, 2));
    console.log("OK");
  });

cmd
  .command("work-product-recall-search")
  .description("Preview work-product recovery candidates when creation-memory recall is enabled")
  .argument("<query>", "Prompt-like query to evaluate against the work-product ledger")
  .option("--max-results <count>", "Maximum number of work-product results to return", "3")
  .option("--session-key <sessionKey>", "Optional session key to boost same-session work products")
  .action(async (...args: unknown[]) => {
    const query = typeof args[0] === "string" ? args[0] : "";
    const options = (args[1] ?? {}) as Record<string, unknown>;
    const maxResults = typeof options.maxResults === "string"
      ? Number.parseInt(options.maxResults, 10)
      : 3;
    const results = await runWorkProductRecallSearchCliCommand({
      memoryDir: orchestrator.config.memoryDir,
      workProductLedgerDir: orchestrator.config.workProductLedgerDir,
      creationMemoryEnabled: resolveCreationMemoryCapabilities(orchestrator.config).creationMemory,
      workProductRecallEnabled: orchestrator.config.workProductRecallEnabled,
      query,
      maxResults: Number.isFinite(maxResults) ? maxResults : 3,
      sessionKey: typeof options.sessionKey === "string" ? options.sessionKey : undefined,
    });
    console.log(JSON.stringify(results, null, 2));
    console.log("OK");
  });
}
