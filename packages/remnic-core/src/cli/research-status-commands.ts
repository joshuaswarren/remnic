/**
 * Research-status command group — extracted from cli.ts (#1532 Phase B).
 *
 * Eleven read-only status / preview commands that are thin wrappers over
 * exported runXxxCliCommand helpers: objective-state, causal-trajectory,
 * trust-zone, abstraction-node, cue-anchor, harmonic-search, and the
 * utility-telemetry / utility-learning family. Each handler reads a few
 * orchestrator.config fields, calls the helper, and prints JSON + "OK".
 *
 * Behaviour is identical to the inline registration it replaces — the
 * cli-command-surface contract tests guard against silent drift.
 *
 * Circular import note: this module imports the runXxx helpers from ../cli.js
 * while ../cli.js imports this module's registrar. This is safe in ESM: the
 * helpers are referenced only inside action callbacks (invoked at runtime,
 * long after both modules have finished evaluating), never at module-eval
 * time, so the live bindings are populated before any action runs.
 */

import type { Orchestrator } from "../orchestrator.js";
import { resolveCapabilities, resolveSecurityCapabilities, resolveUtilityLearningCapabilities, resolveObjectiveStateCapabilities, resolveConsolidationCapabilities } from "../capabilities.js";
import type { CliCommand } from "../cli.js";
import { runHarmonicSearchCliCommand } from "./harmonic-search.js";
import type { UtilityTelemetryEvent } from "../utility-telemetry.js";
import { resolveRecallEnhancementCapabilities } from "../capabilities.js";
import {
  runObjectiveStateStatusCliCommand,
  runCausalTrajectoryStatusCliCommand,
  runTrustZoneStatusCliCommand,
  runTrustZoneDemoSeedCliCommand,
  runAbstractionNodeStatusCliCommand,
  runCueAnchorStatusCliCommand,
  runUtilityTelemetryStatusCliCommand,
  runUtilityTelemetryRecordCliCommand,
  runUtilityLearningStatusCliCommand,
  runUtilityLearningCliCommand,
} from "../cli.js";

/**
 * Register the research-status command group on the parent `engram` command.
 * Extracted verbatim from registerCli; behaviour-preserving.
 */
export function registerResearchStatusCommands(
  cmd: CliCommand,
  orchestrator: Orchestrator,
): void {
  // Resolve recall-operation gates once (#1566 Cluster C — harmonicRetrieval is a
  // mixed-op flag read here on the CLI-search path as well as in recall).
  const caps = resolveCapabilities(orchestrator.config);
cmd
  .command("objective-state-status")
  .description("Show objective-state store status, snapshot counts, and latest stored snapshot")
  .action(async () => {
    const status = await runObjectiveStateStatusCliCommand({
      memoryDir: orchestrator.config.memoryDir,
      objectiveStateStoreDir: orchestrator.config.objectiveStateStoreDir,
      objectiveStateMemoryEnabled: resolveObjectiveStateCapabilities(orchestrator.config).objectiveStateMemory,
      objectiveStateSnapshotWritesEnabled: resolveObjectiveStateCapabilities(orchestrator.config).objectiveStateSnapshotWrites,
    });
    console.log(JSON.stringify(status, null, 2));
    console.log("OK");
  });

cmd
  .command("causal-trajectory-status")
  .description("Show causal-trajectory store status, record counts, and latest stored chain")
  .action(async () => {
    const status = await runCausalTrajectoryStatusCliCommand({
      memoryDir: orchestrator.config.memoryDir,
      causalTrajectoryStoreDir: orchestrator.config.causalTrajectoryStoreDir,
      causalTrajectoryMemoryEnabled: resolveRecallEnhancementCapabilities(orchestrator.config).causalTrajectoryMemory,
    });
    console.log(JSON.stringify(status, null, 2));
    console.log("OK");
  });

cmd
  .command("trust-zone-status")
  .description("Show trust-zone store status, zoned record counts, and latest stored record")
  .action(async () => {
    const status = await runTrustZoneStatusCliCommand({
      memoryDir: orchestrator.config.memoryDir,
      trustZoneStoreDir: orchestrator.config.trustZoneStoreDir,
      trustZonesEnabled: resolveSecurityCapabilities(orchestrator.config).trustZones,
      quarantinePromotionEnabled: resolveSecurityCapabilities(orchestrator.config).quarantinePromotion,
      memoryPoisoningDefenseEnabled: resolveSecurityCapabilities(orchestrator.config).memoryPoisoningDefense,
    });
    console.log(JSON.stringify(status, null, 2));
    console.log("OK");
  });

cmd
  .command("trust-zone-demo-seed")
  .description("Explicitly seed an opt-in trust-zone demo dataset for buyer-facing walkthroughs")
  .option("--scenario <scenario>", "Demo scenario id (default: enterprise-buyer-v1)")
  .option("--recorded-at <isoTimestamp>", "Base ISO timestamp used to anchor demo records")
  .option("--dry-run", "Preview the demo dataset without writing any trust-zone records")
  .action(async (...args: unknown[]) => {
    const options = (args[0] ?? {}) as Record<string, unknown>;
    const result = await runTrustZoneDemoSeedCliCommand({
      memoryDir: orchestrator.config.memoryDir,
      trustZoneStoreDir: orchestrator.config.trustZoneStoreDir,
      trustZonesEnabled: resolveSecurityCapabilities(orchestrator.config).trustZones,
      scenario: typeof options.scenario === "string" ? options.scenario : undefined,
      recordedAt: typeof options.recordedAt === "string" ? options.recordedAt : undefined,
      dryRun: options.dryRun === true,
    });
    console.log(JSON.stringify(result, null, 2));
    console.log("OK");
  });

cmd
  .command("abstraction-node-status")
  .description("Show abstraction-node store status, abstraction counts, and latest stored node")
  .action(async () => {
    const status = await runAbstractionNodeStatusCliCommand({
      memoryDir: orchestrator.config.memoryDir,
      abstractionNodeStoreDir: orchestrator.config.abstractionNodeStoreDir,
      harmonicRetrievalEnabled: caps.harmonicRetrieval,
      abstractionAnchorsEnabled: resolveConsolidationCapabilities(orchestrator.config).abstractionAnchors,
    });
    console.log(JSON.stringify(status, null, 2));
    console.log("OK");
  });

cmd
  .command("cue-anchor-status")
  .description("Show cue-anchor index status, anchor counts, and the latest stored cue anchor")
  .action(async () => {
    const status = await runCueAnchorStatusCliCommand({
      memoryDir: orchestrator.config.memoryDir,
      abstractionNodeStoreDir: orchestrator.config.abstractionNodeStoreDir,
      harmonicRetrievalEnabled: caps.harmonicRetrieval,
      abstractionAnchorsEnabled: resolveConsolidationCapabilities(orchestrator.config).abstractionAnchors,
    });
    console.log(JSON.stringify(status, null, 2));
    console.log("OK");
  });

cmd
  .command("harmonic-search")
  .description("Preview harmonic retrieval blending over abstraction nodes and cue anchors")
  .argument("<query>", "Prompt-like query to evaluate against harmonic retrieval storage")
  .option("--max-results <count>", "Maximum number of blended results to return", "3")
  .option("--session-key <sessionKey>", "Optional session key for same-session tie-breaking")
  .action(async (...args: unknown[]) => {
    const query = typeof args[0] === "string" ? args[0] : "";
    const options = (args[1] ?? {}) as Record<string, unknown>;
    const maxResults = typeof options.maxResults === "string"
      ? Number.parseInt(options.maxResults, 10)
      : 3;
    const results = await runHarmonicSearchCliCommand({
      memoryDir: orchestrator.config.memoryDir,
      abstractionNodeStoreDir: orchestrator.config.abstractionNodeStoreDir,
      harmonicRetrievalEnabled: caps.harmonicRetrieval,
      abstractionAnchorsEnabled: resolveConsolidationCapabilities(orchestrator.config).abstractionAnchors,
      temporalExpiredInInjection: orchestrator.config.temporalExpiredInInjection,
      query,
      maxResults: Number.isFinite(maxResults) ? maxResults : 3,
      sessionKey: typeof options.sessionKey === "string" ? options.sessionKey : undefined,
    });
    console.log(JSON.stringify(results, null, 2));
    console.log("OK");
  });

cmd
  .command("utility-status")
  .description("Show utility-learning telemetry status, event counts, and the latest utility event")
  .action(async () => {
    const status = await runUtilityTelemetryStatusCliCommand({
      memoryDir: orchestrator.config.memoryDir,
      memoryUtilityLearningEnabled: resolveUtilityLearningCapabilities(orchestrator.config).memoryUtilityLearning,
      promotionByOutcomeEnabled: resolveUtilityLearningCapabilities(orchestrator.config).promotionByOutcome,
    });
    console.log(JSON.stringify(status, null, 2));
    console.log("OK");
  });

cmd
  .command("utility-record")
  .description("Record a utility-learning telemetry event when utility learning is enabled")
  .requiredOption("--event-id <eventId>", "Utility telemetry event id")
  .requiredOption("--recorded-at <recordedAt>", "ISO timestamp for the event")
  .requiredOption("--session-key <sessionKey>", "Session key associated with the event")
  .requiredOption("--source <source>", "Event source (cli|system|benchmark|tool_result)")
  .requiredOption("--target <target>", "Telemetry target (promotion|ranking)")
  .requiredOption("--decision <decision>", "Decision taken (promote|demote|hold|boost|suppress)")
  .requiredOption("--outcome <outcome>", "Observed outcome (helpful|neutral|harmful)")
  .requiredOption("--utility-score <utilityScore>", "Bounded utility score between -1 and 1")
  .requiredOption("--summary <summary>", "Human-readable summary of the measured utility event")
  .option("--memory-id <memoryId...>", "Memory ids linked to the utility event")
  .option("--entity-ref <entityRef...>", "Entity refs linked to the utility event")
  .option("--tag <tag...>", "Tags to attach to the utility event")
  .action(async (...args: unknown[]) => {
    const options = (args[0] ?? {}) as Record<string, unknown>;
    const utilityScore = typeof options.utilityScore === "string"
      ? Number.parseFloat(options.utilityScore)
      : Number.NaN;
    const filePath = await runUtilityTelemetryRecordCliCommand({
      memoryDir: orchestrator.config.memoryDir,
      memoryUtilityLearningEnabled: resolveUtilityLearningCapabilities(orchestrator.config).memoryUtilityLearning,
      event: {
        schemaVersion: 1,
        eventId: String(options.eventId ?? ""),
        recordedAt: String(options.recordedAt ?? ""),
        sessionKey: String(options.sessionKey ?? ""),
        source: String(options.source ?? "") as UtilityTelemetryEvent["source"],
        target: String(options.target ?? "") as UtilityTelemetryEvent["target"],
        decision: String(options.decision ?? "") as UtilityTelemetryEvent["decision"],
        outcome: String(options.outcome ?? "") as UtilityTelemetryEvent["outcome"],
        utilityScore,
        summary: String(options.summary ?? ""),
        memoryIds: Array.isArray(options.memoryId) ? options.memoryId.map(String) : undefined,
        entityRefs: Array.isArray(options.entityRef) ? options.entityRef.map(String) : undefined,
        tags: Array.isArray(options.tag) ? options.tag.map(String) : undefined,
      },
    });
    console.log(JSON.stringify({ wrote: filePath !== null, filePath }, null, 2));
    console.log("OK");
  });

cmd
  .command("utility-learning-status")
  .description("Show offline utility-learning snapshot status and learned weight counts")
  .action(async () => {
    const status = await runUtilityLearningStatusCliCommand({
      memoryDir: orchestrator.config.memoryDir,
      memoryUtilityLearningEnabled: resolveUtilityLearningCapabilities(orchestrator.config).memoryUtilityLearning,
      promotionByOutcomeEnabled: resolveUtilityLearningCapabilities(orchestrator.config).promotionByOutcome,
    });
    console.log(JSON.stringify(status, null, 2));
    console.log("OK");
  });

cmd
  .command("utility-learn")
  .description("Learn bounded offline promotion/ranking weights from recorded utility telemetry")
  .option("--window-days <days>", "Telemetry lookback window in days", "14")
  .option("--min-event-count <count>", "Minimum event count required per target/decision group", "3")
  .option("--max-weight-magnitude <value>", "Maximum absolute learned weight magnitude", "0.35")
  .action(async (...args: unknown[]) => {
    const options = (args[0] ?? {}) as Record<string, unknown>;
    const learningWindowDays = typeof options.windowDays === "string"
      ? Number.parseInt(options.windowDays, 10)
      : 14;
    const minEventCount = typeof options.minEventCount === "string"
      ? Number.parseInt(options.minEventCount, 10)
      : 3;
    const maxWeightMagnitude = typeof options.maxWeightMagnitude === "string"
      ? Number.parseFloat(options.maxWeightMagnitude)
      : 0.35;
    const result = await runUtilityLearningCliCommand({
      memoryDir: orchestrator.config.memoryDir,
      memoryUtilityLearningEnabled: resolveUtilityLearningCapabilities(orchestrator.config).memoryUtilityLearning,
      learningWindowDays,
      minEventCount,
      maxWeightMagnitude,
    });
    console.log(JSON.stringify(result, null, 2));
    console.log("OK");
  });
}
