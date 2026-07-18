import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildCodexCreditReceipt, type CodexCreditBudgetConfig } from "@remnic/bench";

import { runRelayCodexOneShot } from "./codex-one-shot.js";
import {
  RELAY_ACCOUNT_CREDIT_CAP_UNITS,
  RELAY_CREDIT_BUDGET_UNITS,
  RELAY_CREDIT_RESERVE_UNITS,
  RELAY_OPERATOR_PRINCIPAL,
  RELAY_QUARANTINED_ATTEMPT_UNITS,
  type RelayRole,
} from "./contracts.js";
import {
  cleanupRelayRun,
  pathExists,
  prepareRelayRunDirectories,
  type RelayRunDirectories,
} from "./isolation.js";
import { runRelayMission, type RelayCodexExecutor } from "./mission-runner.js";
import { runRelayPreflight } from "./preflight-lib.js";
import { startRelayRemnicHarness, type RelayRemnicHarness } from "./remnic-harness.js";
import { verifyRelayRecording, writeRelayRecording } from "./recording.js";

const CODEX_ONE_SHOT_TIMEOUT_MS = 10 * 60 * 1_000;

interface CliOptions {
  runRoot?: string;
  recordingDir: string;
  keepArtifacts: boolean;
  approvalPhrase: string;
  operatorPrincipal: string;
  quarantinedLedgerPath?: string;
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(argv: string[], repoRoot: string): CliOptions {
  let runRoot: string | undefined;
  let recordingDir = path.join(repoRoot, "docs", "remnic-relay", "recordings", "gpt-5-6-checkout-recovery");
  let keepArtifacts = false;
  let approvalPhrase = "";
  let operatorPrincipal = "";
  let quarantinedLedgerPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--run-root") {
      runRoot = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === "--recording-dir") {
      recordingDir = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === "--approve-correction") {
      approvalPhrase = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === "--operator") {
      operatorPrincipal = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === "--quarantine-uncertain-alias-ledger") {
      quarantinedLedgerPath = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === "--keep-artifacts") {
      keepArtifacts = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: npm run relay:live -- --approve-correction APPROVE --operator relay-build-week-operator " +
          "[--run-root <empty-path>] [--recording-dir <new-directory>] [--keep-artifacts]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown Relay live argument: ${arg}`);
    }
  }
  return {
    ...(runRoot ? { runRoot } : {}),
    recordingDir: path.resolve(recordingDir),
    keepArtifacts,
    approvalPhrase,
    operatorPrincipal,
    ...(quarantinedLedgerPath ? { quarantinedLedgerPath: path.resolve(quarantinedLedgerPath) } : {}),
  };
}

function assertRecordingDestination(repoRoot: string, recordingDir: string): void {
  const parent = path.join(repoRoot, "docs", "remnic-relay", "recordings");
  const relation = path.relative(parent, recordingDir);
  if (!relation || relation === ".." || relation.startsWith(`..${path.sep}`)) {
    throw new Error("Relay live recording must be a named child of docs/remnic-relay/recordings");
  }
}

class LiveRelayExecutor implements RelayCodexExecutor {
  constructor(
    private readonly repoRoot: string,
    private readonly directories: RelayRunDirectories,
    private readonly codexBinary: string,
    private readonly authSourcePath: string,
    private readonly harness: RelayRemnicHarness,
    private readonly budget: CodexCreditBudgetConfig,
    private readonly signal: AbortSignal,
  ) {}

  async execute(role: RelayRole, workspace: string) {
    return await runRelayCodexOneShot({
      repoRoot: this.repoRoot,
      directories: this.directories,
      role,
      workspace,
      codexBinary: this.codexBinary,
      authSourcePath: this.authSourcePath,
      mcpUrl: this.harness.mcpUrl,
      mcpToken: this.harness.mcpToken,
      timeoutMs: CODEX_ONE_SHOT_TIMEOUT_MS,
      budget: this.budget,
      signal: this.signal,
    });
  }
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const options = parseArgs(process.argv.slice(2), repoRoot);
  assertRecordingDestination(repoRoot, options.recordingDir);
  if (await pathExists(options.recordingDir)) {
    throw new Error("Relay live recording already exists; refusing to spend credits on an overwrite");
  }
  const defaultLedgerPath = path.join(repoRoot, ".remnic", "relay", "codex-credit-ledger.json");
  if (options.quarantinedLedgerPath && options.quarantinedLedgerPath !== defaultLedgerPath) {
    throw new Error("Relay only permits quarantining its dedicated rejected-alias ledger");
  }
  const quarantinedUncertainUnits = options.quarantinedLedgerPath ? RELAY_QUARANTINED_ATTEMPT_UNITS : 0;
  const creditBudgetUnits = RELAY_ACCOUNT_CREDIT_CAP_UNITS - quarantinedUncertainUnits;
  const ledgerPath = options.quarantinedLedgerPath
    ? path.join(repoRoot, ".remnic", "relay", "codex-credit-ledger-terra.json")
    : defaultLedgerPath;
  const runId = `relay-build-week-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const directories = await prepareRelayRunDirectories(repoRoot, options.runRoot);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  let harness: RelayRemnicHarness | undefined;
  try {
    const preflight = await runRelayPreflight({
      repoRoot,
      directories,
      ledgerPath,
      creditBudgetUnits,
      ...(options.quarantinedLedgerPath ? { quarantinedLedgerPath: options.quarantinedLedgerPath } : {}),
    });
    await writeFile(
      path.join(directories.outputsDir, "live-checkpoint.json"),
      `${JSON.stringify({ schemaVersion: 1, runId, preflight: preflight.receipt }, null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    if (controller.signal.aborted) throw new Error("Relay live run was cancelled after preflight");
    harness = await startRelayRemnicHarness(directories.memoryDir);
    const budget: CodexCreditBudgetConfig = {
      budgetCredits: creditBudgetUnits,
      reserveCredits: RELAY_CREDIT_RESERVE_UNITS,
      ledgerPath,
      allowSol: false,
      runId,
    };
    const executor = new LiveRelayExecutor(
      repoRoot,
      directories,
      preflight.codexBinary,
      preflight.authSourcePath,
      harness,
      budget,
      controller.signal,
    );
    const missionRun = await runRelayMission({
      repoRoot,
      directories,
      executor,
      harness,
      approval: {
        phrase: options.approvalPhrase,
        operatorPrincipal: options.operatorPrincipal,
      },
      signal: controller.signal,
    });
    const creditReceipt = await buildCodexCreditReceipt(ledgerPath, runId);
    const recordingSha256 = await writeRelayRecording({
      recordingDir: options.recordingDir,
      repoRoot,
      generatedAt: new Date().toISOString(),
      preflight: preflight.receipt,
      creditReceipt,
      runId,
      missionRun,
    });
    const verified = await verifyRelayRecording(options.recordingDir, repoRoot);
    if (verified.rootSha256 !== recordingSha256) {
      throw new Error("Relay recording changed during final verification");
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          status: "completed",
          recording: path.relative(repoRoot, options.recordingDir),
          recordingSha256,
          missionReceiptSha256: missionRun.missionReceiptSha256,
          model: verified.metadata.model,
          calls: verified.creditReceipt.run.calls,
          creditUnitsSpent: verified.creditReceipt.run.budgetUnits,
          accountCreditCapUnits: RELAY_ACCOUNT_CREDIT_CAP_UNITS,
          quarantinedUncertainUnits,
          productionDataRead: false,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    await harness?.stop().catch(() => undefined);
    if (!options.keepArtifacts) await cleanupRelayRun(directories);
    else process.stderr.write(`Relay isolated artifacts retained at ${directories.root}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`Relay live run failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
