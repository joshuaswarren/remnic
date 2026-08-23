import fs from "node:fs";
import {
  Orchestrator,
  initLogger,
  parseConfig,
  resolveRemnicConfigRecord,
  runPreferenceDriftScan,
  type PreferenceDriftReport,
} from "@remnic/core";
import { hasFlag, resolveFlag } from "../cli-args.js";
import { expandTilde } from "../path-utils.js";
import { resolveConfigPath } from "../config-path.js";
import { resolveMemoryDir } from "../index.js";

export async function runDriftBinaryCommand(rest: string[]): Promise<void> {
  initLogger();
  const subcommand = rest[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    console.log(`remnic drift — Preference drift detection (issue #2371)

Usage:
  remnic drift scan [--apply] [--namespace <ns>] [--format json|text] [--memory-dir <path>]

Subcommands:
  scan                 Classify aging preference memories as corroborated /
                       stale / drifted from recent evidence. Reports only by
                       default. --apply stamps lastCorroborated / driftState
                       and opens one review item per drifted preference
                       (requires driftDetection.enabled in config). Never
                       auto-deletes and never auto-supersedes.

Shared with:
  MCP remnic.preference_drift_scan (alias engram.preference_drift_scan)

Resolve a drifted item with the existing review surface:
  remnic.review_list / remnic.review_resolve, verbs: keep, supersede, archive`);
    return;
  }

  if (subcommand !== "scan") {
    console.error(`Unknown drift subcommand "${subcommand}". Run \`remnic drift --help\` for usage.`);
    process.exit(1);
  }

  const args = rest.slice(1);
  const formatPresent = hasFlag(args, "--format");
  const formatRaw = resolveFlag(args, "--format");
  if (formatPresent && (formatRaw === undefined || formatRaw === null)) {
    console.error("--format requires a value. Use `--format json` or `--format text`.");
    process.exit(1);
  }
  const format = (() => {
    if (!formatPresent || formatRaw === undefined || formatRaw === null) return "text";
    const normalized = String(formatRaw).trim().toLowerCase();
    if (normalized !== "text" && normalized !== "json") {
      console.error(`Invalid --format "${formatRaw}". Allowed: text, json.`);
      process.exit(1);
    }
    return normalized;
  })();

  const memoryDirPresent = hasFlag(args, "--memory-dir");
  const memoryDirOverride = resolveFlag(args, "--memory-dir");
  if (memoryDirPresent && (memoryDirOverride === undefined || memoryDirOverride === null)) {
    console.error("--memory-dir requires a path. Omit the flag to use the resolved default.");
    process.exit(1);
  }
  const namespacePresent = hasFlag(args, "--namespace");
  const namespaceOverride = resolveFlag(args, "--namespace");
  if (namespacePresent && (namespaceOverride === undefined || namespaceOverride === null)) {
    console.error("--namespace requires a value. Omit the flag to scan the default namespace.");
    process.exit(1);
  }

  const configPath = resolveConfigPath();
  const raw = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
  const config = parseConfig(resolveRemnicConfigRecord(raw));
  const memoryDirOverridden =
    typeof memoryDirOverride === "string" && memoryDirOverride.length > 0;
  const memoryDir = expandTilde(
    memoryDirOverridden ? memoryDirOverride : config.memoryDir ?? resolveMemoryDir(),
  );

  // A real orchestrator, not a bare StorageManager: classification needs the
  // embedding lookup and judge LLM it owns. Without them every preference
  // reports `skipped: backend_unavailable`, which is an honest refusal but not
  // a working scan.
  const orchestrator = new Orchestrator(
    memoryDirOverridden ? { ...config, memoryDir } : config,
  );
  await orchestrator.initialize();
  const storage = await orchestrator.getStorageForNamespace(
    typeof namespaceOverride === "string" && namespaceOverride.length > 0
      ? namespaceOverride
      : undefined,
  );
  const report = await runPreferenceDriftScan({
    storage,
    config: orchestrator.config,
    memoryDir,
    // Deliberately NOT wrapped in a swallowing try/catch: the drift scan's
    // §22 contract is that a thrown lookup means `backend_unavailable`, and
    // returning `[]` on failure would misreport a live preference as stale.
    embeddingLookupFactory: (scanStorage) => (content, limit) =>
      orchestrator.semanticDedupLookup(content, limit, scanStorage),
    storageForNamespace: async (namespace) => {
      const resolvedNamespace = namespace?.trim() || undefined;
      return {
        storage: await orchestrator.getStorageForNamespace(resolvedNamespace),
        namespace: resolvedNamespace,
      };
    },
    localLlm: orchestrator.localLlm ?? null,
    fallbackLlm: orchestrator.fastGatewayLlm ?? null,
    namespace: typeof namespaceOverride === "string" ? namespaceOverride : undefined,
    apply: hasFlag(args, "--apply"),
  });

  if (format === "json") {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }
  process.stdout.write(formatPreferenceDriftText(report));
}

function formatPreferenceDriftText(report: PreferenceDriftReport): string {
  const lines: string[] = [];
  lines.push(`Preference drift — ${report.mode} run at ${report.generatedAt}`);
  if (report.skippedReason) {
    lines.push(
      report.skippedReason === "drift_disabled"
        ? "  skipped: driftDetection.enabled is false"
        : "  skipped: driftDetection.maxCandidatesPerRun is 0",
    );
    return lines.join("\n") + "\n";
  }
  if (report.namespace) lines.push(`  namespace: ${report.namespace}`);
  lines.push(`  eligible preferences: ${report.eligible} (classified ${report.scanned})`);
  lines.push(
    `  corroborated=${report.counts.corroborated} stale=${report.counts.stale} ` +
      `drifted=${report.counts.drifted} skipped=${report.counts.skipped}`,
  );
  lines.push(`  applied writes: ${report.appliedCount} (review items opened: ${report.reviewItemsOpened})`);
  for (const finding of report.findings) {
    const skip = finding.skipped ? ` [${finding.skipped}]` : "";
    lines.push(`  - ${finding.memoryId}: ${finding.classification}${skip} (${finding.ageDays}d old)`);
    lines.push(`      ${finding.reason}`);
    if (finding.reviewPairId) lines.push(`      review item: ${finding.reviewPairId}`);
  }
  lines.push(`  elapsed: ${report.elapsedMs}ms`);
  return lines.join("\n") + "\n";
}
