import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  type RelayEvidenceRef,
  type RelayMissionPayload,
  type RelayMissionSnapshot,
  RelayMissionStore,
  relayMissionReceiptDigest,
} from "@remnic/core";

import {
  RELAY_COLD_PROBE_SESSION_KEY,
  RELAY_CONFLICT_ID,
  RELAY_CORRECTION_ID,
  RELAY_MAX_LIVE_CALLS,
  RELAY_MISSION_ID,
  RELAY_NAMESPACE,
  RELAY_OPERATOR_PRINCIPAL,
  RELAY_QUERY,
  RELAY_REPLACEMENT_DECISION_ID,
  RELAY_STALE_DECISION_ID,
  RELAY_STALE_PROBE_SESSION_KEY,
  type RelayBuilderOutput,
  RelayBuilderOutputSchema,
  type RelayBuilderRole,
  type RelayCodexCallResult,
  type RelayCodexCallSummary,
  RelayCodexCallSummarySchema,
  type RelayResolverOutput,
  RelayResolverOutputSchema,
  type RelayRole,
  type RelayScoutOutput,
  RelayScoutOutputSchema,
  type RelayTestResult,
  RelayTestResultSchema,
  relayBuilderSessionKey,
} from "./contracts.js";
import { verifyRelayFixtureManifest } from "./fixture-manifest.js";
import {
  type FixtureDigest,
  type RelayRunDirectories,
  assertTreeContainsNoSymlinks,
  copyFixtureTree,
  digestFixtureTree,
} from "./isolation.js";
import { RELAY_UNSHARE_NAMESPACE_ARGS } from "./network-gateway.js";
import type { RelayCorrectionResult, RelayRemnicHarness } from "./remnic-harness.js";
import {
  RELAY_CANONICAL_CHECKOUT_DECISION,
  assertRelayCheckoutDecision,
  assertRelaySourceLocators,
  normalizeRelaySourceLocator,
} from "./source-grounding.js";

const PROCESS_OUTPUT_LIMIT = 1024 * 1024;
const PROCESS_TIMEOUT_MS = 20_000;
const STALE_DECISION = "Mint a new checkout token for every request and every retry.";
const BUILDER_CHANGED_FILE = "src/token-policy.mjs";
const PUBLIC_CONTRACT_TEST_NAMES = ["the first checkout request obtains a token"] as const;
const HIDDEN_CONTRACT_TEST_NAMES = [
  "ordinary retries reuse the checkout-session token",
  "expiry mints one replacement that later retries reuse",
] as const;

export interface RelayCodexExecutor {
  execute(role: RelayRole, workspace: string): Promise<RelayCodexCallResult<unknown>>;
}

export interface RelayApproval {
  phrase: string;
  operatorPrincipal: string;
}

export interface SanitizedRelayCall<T = unknown> {
  summary: RelayCodexCallSummary;
  output: T;
}

export interface RelayMissionRunResult {
  fixtureManifestSha256: string;
  mission: RelayMissionSnapshot;
  missionReceiptSha256: string;
  calls: [
    SanitizedRelayCall<RelayScoutOutput>,
    SanitizedRelayCall<RelayBuilderOutput>,
    SanitizedRelayCall<RelayResolverOutput>,
    SanitizedRelayCall<RelayBuilderOutput>,
  ];
  tests: [RelayTestResult, RelayTestResult];
  staleMemoryId: string;
  replacementMemoryId: string;
  correction: {
    planId: string;
    outcomeStatus: string;
    staleMemoryStatus: string;
    resolverBridgeRequests: number;
  };
  approval: {
    approved: true;
    operatorPrincipal: string;
  };
}

export interface RunRelayMissionOptions {
  repoRoot: string;
  directories: RelayRunDirectories;
  executor: RelayCodexExecutor;
  harness: RelayRemnicHarness;
  approval: RelayApproval;
  now?: () => Date;
  signal?: AbortSignal;
}

interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function validateSourceGrounding(workspace: string, locators: string[], decision: string): Promise<void> {
  assertRelayCheckoutDecision(decision, "source-grounded");
  const normalized = assertRelaySourceLocators(locators, "live source");
  for (const relative of normalized) {
    const candidate = path.resolve(workspace, relative);
    const relation = path.relative(workspace, candidate);
    if (relation === ".." || relation.startsWith(`..${path.sep}`)) {
      throw new Error(`Relay source locator escaped the synthetic workspace: ${relative}`);
    }
    const info = await lstat(candidate);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Relay source locator must resolve to a real fixture file: ${relative}`);
    }
  }
}

async function runProcess(
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<ProcessResult> {
  const startedAt = Date.now();
  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    let timedOut = false;
    const capture = (target: "stdout" | "stderr", chunk: Buffer) => {
      const next = (target === "stdout" ? stdout : stderr) + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > PROCESS_OUTPUT_LIMIT) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      if (target === "stdout") stdout = next;
      else stderr = next;
    };
    child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
    child.once("error", reject);
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, PROCESS_TIMEOUT_MS);
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      if (overflow) reject(new Error("Relay contract test exceeded its output limit"));
      else if (timedOut) reject(new Error("Relay contract test timed out"));
      else resolve({ exitCode, stdout, stderr, durationMs: Date.now() - startedAt });
    });
  });
}

async function resolveContractRuntimeBinary(label: string, candidates: string[]): Promise<string> {
  for (const candidate of candidates) {
    try {
      const resolved = await realpath(candidate);
      const info = await lstat(resolved);
      if (info.isFile() && !info.isSymbolicLink()) return resolved;
    } catch {
      // Try the next fixed system location.
    }
  }
  throw new Error(`Relay contract sandbox could not resolve ${label}`);
}

async function runIsolatedContractTest(
  workspace: string,
  kind: "public" | "hidden",
  runId: string,
  hiddenTest?: string
): Promise<ProcessResult> {
  await assertTreeContainsNoSymlinks(workspace);
  if (kind === "hidden") {
    if (!hiddenTest) throw new Error("Relay hidden contract sandbox requires a test file");
    const hiddenInfo = await lstat(hiddenTest);
    if (hiddenInfo.isSymbolicLink() || !hiddenInfo.isFile()) {
      throw new Error("Relay hidden contract sandbox requires a regular non-symlink test file");
    }
  }
  const isolationScript = path.resolve(import.meta.dirname, "isolate-contract-test.sh");
  const isolationInfo = await lstat(isolationScript);
  if (isolationInfo.isSymbolicLink() || !isolationInfo.isFile()) {
    throw new Error("Relay contract isolation script must be a regular non-symlink file");
  }
  const [unshare, nodeBinary, setpriv] = await Promise.all([
    resolveContractRuntimeBinary("unshare", ["/usr/bin/unshare", "/bin/unshare"]),
    resolveContractRuntimeBinary("Node.js", [process.execPath]),
    resolveContractRuntimeBinary("setpriv", ["/usr/bin/setpriv", "/bin/setpriv"]),
  ]);
  const rootfs = await mkdtemp(path.join(os.tmpdir(), "remnic-relay-contract-rootfs-"));
  try {
    return await runProcess(unshare, [...RELAY_UNSHARE_NAMESPACE_ARGS, isolationScript], {
      cwd: workspace,
      env: {
        PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        RELAY_ROOTFS: rootfs,
        RELAY_WORKSPACE: workspace,
        RELAY_TEST_KIND: kind,
        RELAY_TEST_RUN: runId,
        RELAY_NODE_BIN: nodeBinary,
        RELAY_SETPRIV_BIN: setpriv,
        ...(hiddenTest ? { RELAY_HIDDEN_TEST: hiddenTest } : {}),
      },
    });
  } finally {
    await rm(rootfs, { recursive: true, force: true });
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nodeTestSummaryCount(output: string, label: string, context: string): number {
  const matches = [...output.matchAll(new RegExp(`^# ${label} (\\d+)\\s*$`, "gm"))];
  if (matches.length !== 1) {
    throw new Error(`Relay ${context} contract test did not emit one trusted ${label} summary`);
  }
  return Number(matches[0]?.[1]);
}

function assertExpectedNodeTestResults(
  result: ProcessResult,
  expectedNames: readonly string[],
  expectedStatus: "passed" | "failed",
  context: string
): void {
  const output = `${result.stdout}\n${result.stderr}`;
  for (const name of expectedNames) {
    const resultLine = new RegExp(`^(?:not )?ok\\s+\\d+\\s+-\\s+${escapeRegExp(name)}\\s*$`, "m");
    if (!resultLine.test(output)) {
      throw new Error(`Relay ${context} contract test did not execute expected assertion: ${name}`);
    }
  }
  const tests = nodeTestSummaryCount(output, "tests", context);
  const passed = nodeTestSummaryCount(output, "pass", context);
  const failed = nodeTestSummaryCount(output, "fail", context);
  const cancelled = nodeTestSummaryCount(output, "cancelled", context);
  const skipped = nodeTestSummaryCount(output, "skipped", context);
  const todo = nodeTestSummaryCount(output, "todo", context);
  if (tests !== expectedNames.length || passed + failed !== tests || cancelled !== 0 || skipped !== 0 || todo !== 0) {
    throw new Error(`Relay ${context} contract test emitted an incomplete assertion receipt`);
  }
  if (expectedStatus === "passed" && (result.exitCode !== 0 || passed !== tests || failed !== 0)) {
    throw new Error(`Relay ${context} Builder failed the expected contract assertions`);
  }
  if (expectedStatus === "failed" && (result.exitCode === 0 || failed < 1)) {
    throw new Error(`Relay ${context} stale Builder did not fail an expected contract assertion`);
  }
}

export async function runRelayPublicContractTest(workspace: string, runId: string): Promise<void> {
  const result = await runIsolatedContractTest(workspace, "public", runId);
  assertExpectedNodeTestResults(result, PUBLIC_CONTRACT_TEST_NAMES, "passed", `${runId} public`);
}

export async function runRelayHiddenContractTest(
  fixtureRoot: string,
  workspace: string,
  phase: "before-correction" | "after-correction"
): Promise<RelayTestResult> {
  const hiddenTest = path.join(fixtureRoot, "hidden", "token-policy.hidden.test.mjs");
  const result = await runIsolatedContractTest(workspace, "hidden", phase, hiddenTest);
  const combined = `${result.stdout}\n${result.stderr}`;
  const passed = result.exitCode === 0;
  if (phase === "before-correction") {
    assertExpectedNodeTestResults(result, HIDDEN_CONTRACT_TEST_NAMES, "failed", phase);
    if (passed || !/retry minted a second token|ordinary retry must not mint again/.test(combined)) {
      throw new Error("Relay stale implementation did not fail for the intended hidden retry invariant");
    }
  } else {
    assertExpectedNodeTestResults(result, HIDDEN_CONTRACT_TEST_NAMES, "passed", phase);
  }
  return RelayTestResultSchema.parse({
    phase,
    status: passed ? "passed" : "failed",
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    command: "node --test fixtures/remnic-relay/hidden/token-policy.hidden.test.mjs",
    summary:
      phase === "before-correction"
        ? "The stale decision rotated the token on an ordinary retry, violating session idempotency."
        : "The cold agent reused the valid session token and minted exactly one replacement after expiry.",
    outputSha256: sha256(combined),
  });
}

function changedPaths(before: FixtureDigest[], after: FixtureDigest[]): string[] {
  const beforeMap = new Map(before.map((item) => [item.path, `${item.bytes}:${item.sha256}`]));
  const afterMap = new Map(after.map((item) => [item.path, `${item.bytes}:${item.sha256}`]));
  return [...new Set([...beforeMap.keys(), ...afterMap.keys()])]
    .filter((item) => beforeMap.get(item) !== afterMap.get(item))
    .sort();
}

async function validateBuilderWorkspace(
  fixtureRoot: string,
  workspace: string,
  output: RelayBuilderOutput,
  runId: string
): Promise<void> {
  await assertTreeContainsNoSymlinks(workspace);
  const [before, after] = await Promise.all([
    digestFixtureTree(path.join(fixtureRoot, "downstream")),
    digestFixtureTree(workspace),
  ]);
  const changed = changedPaths(before, after);
  if (JSON.stringify(changed) !== JSON.stringify([BUILDER_CHANGED_FILE])) {
    throw new Error(`Relay ${runId} Builder changed files outside ${BUILDER_CHANGED_FILE}: ${changed.join(", ")}`);
  }
  const reported = [...new Set(output.files_changed.map(normalizeRelaySourceLocator))].sort();
  if (JSON.stringify(reported) !== JSON.stringify([BUILDER_CHANGED_FILE])) {
    throw new Error(`Relay ${runId} Builder reported an unexpected mutation set`);
  }
  if (!output.tests_run.some((item) => /npm\s+test/i.test(item))) {
    throw new Error(`Relay ${runId} Builder did not report running npm test`);
  }
  await runRelayPublicContractTest(workspace, runId);
}

function validateRecallOutput(
  output: RelayBuilderOutput,
  summary: RelayCodexCallSummary,
  expectedMemoryId: string,
  runId: string
): void {
  if (
    summary.recallToolCalls !== 1 ||
    summary.recallReceipt?.query !== RELAY_QUERY ||
    summary.recallReceipt.namespace !== RELAY_NAMESPACE ||
    JSON.stringify(summary.recallReceipt.memoryIds) !== JSON.stringify([expectedMemoryId])
  ) {
    throw new Error(`Relay ${runId} Builder's completed MCP receipt did not cite the active Remnic memory id`);
  }
  if (output.recall_memory_id !== expectedMemoryId) {
    throw new Error(`Relay ${runId} Builder did not cite the active Remnic memory id`);
  }
  if (!/remnic|memory|recall|relay-build-week/i.test(output.recall_provenance)) {
    throw new Error(`Relay ${runId} Builder did not report Remnic recall provenance`);
  }
}

function sourceEvidence(): RelayEvidenceRef {
  return {
    kind: "source",
    id: "source-checkout-contract",
    label: "Authoritative checkout token contract",
    locator: "fixtures/remnic-relay/upstream/CONTRACT.md",
    capture: "at_action",
  };
}

function testEvidence(): RelayEvidenceRef {
  return {
    kind: "test",
    id: "test-checkout-hidden-contract",
    label: "Hidden checkout token contract",
    locator: "fixtures/remnic-relay/hidden/token-policy.hidden.test.mjs",
    capture: "at_action",
  };
}

function callEvidence(role: RelayRole): RelayEvidenceRef {
  return {
    kind: "agent_output",
    id: `output-${role}`,
    label: `${role} GPT-5.6 one-shot output`,
    locator: `recording://calls/${role}.json`,
    capture: "at_action",
  };
}

function assertApproval(approval: RelayApproval): void {
  if (approval.phrase !== "APPROVE") {
    throw new Error("Relay live correction requires the exact --approve-correction APPROVE gate");
  }
  if (approval.operatorPrincipal !== RELAY_OPERATOR_PRINCIPAL) {
    throw new Error(`Relay live correction requires operator ${RELAY_OPERATOR_PRINCIPAL}`);
  }
}

function sanitizedCall<T>(result: RelayCodexCallResult<unknown>, role: RelayRole, output: T): SanitizedRelayCall<T> {
  const summary = RelayCodexCallSummarySchema.parse(result.summary);
  if (summary.role !== role || summary.status !== "completed" || summary.exitCode !== 0) {
    throw new Error(`Relay ${role} call did not complete under the fixed call contract`);
  }
  const expectsRecall = role === "stale-builder" || role === "cold-builder";
  if ((expectsRecall && !summary.recallReceipt) || (!expectsRecall && summary.recallReceipt)) {
    throw new Error(`Relay ${role} call did not preserve its deterministic recall receipt contract`);
  }
  return { summary, output };
}

function correctionReceipt(result: RelayCorrectionResult) {
  if (result.outcome.status !== "applied" || result.staleMemoryStatus !== "superseded") {
    throw new Error("Relay correction did not atomically supersede the stale decision");
  }
  if (result.resolverBridgeRequests !== 1) {
    throw new Error("Relay correction planner did not consume exactly one approved Resolver result");
  }
  return {
    planId: result.plan.planId,
    outcomeStatus: result.outcome.status,
    staleMemoryStatus: result.staleMemoryStatus,
    resolverBridgeRequests: result.resolverBridgeRequests,
  };
}

async function prepareWorkspace(parent: string, name: string, source: string): Promise<string> {
  const destination = path.join(parent, name);
  await mkdir(destination, { mode: 0o700 });
  await copyFixtureTree(source, destination);
  return destination;
}

function createMonotonicClock(now: () => Date): () => string {
  let last = Number.NEGATIVE_INFINITY;
  return () => {
    const candidate = now().getTime();
    if (!Number.isFinite(candidate)) throw new Error("Relay mission clock returned an invalid timestamp");
    last = Math.max(candidate, last + 1);
    return new Date(last).toISOString();
  };
}

export async function runRelayMission(options: RunRelayMissionOptions): Promise<RelayMissionRunResult> {
  if (options.signal?.aborted) throw new Error("Relay mission was cancelled before dispatch");
  assertApproval(options.approval);
  const fixtureRoot = path.join(options.repoRoot, "fixtures", "remnic-relay");
  const fixtureManifest = await verifyRelayFixtureManifest(fixtureRoot);
  const nextOccurredAt = createMonotonicClock(options.now ?? (() => new Date()));
  const store = new RelayMissionStore({ rootDir: options.directories.sharedContextDir, namespace: RELAY_NAMESPACE });
  let eventIndex = 0;
  const append = async (payload: RelayMissionPayload) => {
    eventIndex += 1;
    await store.append(
      RELAY_MISSION_ID,
      {
        occurredAt: nextOccurredAt(),
        idempotencyKey: `live-${String(eventIndex).padStart(3, "0")}`,
        payload,
      },
      { authenticatedPrincipal: options.approval.operatorPrincipal }
    );
  };

  const [scoutWorkspace, staleWorkspace, resolverWorkspace, coldWorkspace] = await Promise.all([
    prepareWorkspace(options.directories.workspacesDir, "scout", path.join(fixtureRoot, "upstream")),
    prepareWorkspace(options.directories.workspacesDir, "stale-builder", path.join(fixtureRoot, "downstream")),
    prepareWorkspace(options.directories.workspacesDir, "resolver", path.join(fixtureRoot, "upstream")),
    prepareWorkspace(options.directories.workspacesDir, "cold-builder", path.join(fixtureRoot, "downstream")),
  ]);
  const staleMemoryId = await options.harness.seedStaleDecision();
  await options.harness.proveMcpRecall(staleMemoryId, RELAY_STALE_PROBE_SESSION_KEY);
  const calls: Array<SanitizedRelayCall> = [];
  const threadIds = new Set<string>();
  const execute = async (role: RelayRole, workspace: string): Promise<RelayCodexCallResult<unknown>> => {
    if (options.signal?.aborted) throw new Error(`Relay mission was cancelled before ${role} dispatch`);
    if (calls.length >= RELAY_MAX_LIVE_CALLS) throw new Error("Relay refused a fifth Codex call");
    const result = await options.executor.execute(role, workspace);
    const summary = RelayCodexCallSummarySchema.parse(result.summary);
    if (summary.role !== role) throw new Error(`Relay executor returned ${summary.role} for ${role}`);
    if (
      (role === "stale-builder" || role === "cold-builder") &&
      summary.recallReceipt?.sessionKey !== relayBuilderSessionKey(role as RelayBuilderRole)
    ) {
      throw new Error(`Relay ${role} receipt did not prove its distinct transcript-free session key`);
    }
    if (threadIds.has(summary.threadId)) throw new Error("Relay one-shots must use distinct fresh Codex threads");
    threadIds.add(summary.threadId);
    return result;
  };

  await append({
    kind: "mission_started",
    title: "The checkout token split",
    objective: "Resolve a stale shared decision and prove a transcript-free cold Codex agent recovers the outcome.",
    runMode: "live",
    evidence: [sourceEvidence()],
  });
  await append({
    kind: "agent_status",
    agentId: "agent-scout",
    sessionId: "session-scout",
    label: "Scout",
    role: "Authoritative-source verification",
    status: "working",
    evidence: [sourceEvidence()],
  });
  await append({
    kind: "agent_status",
    agentId: "agent-stale-builder",
    sessionId: "session-stale-builder",
    label: "Builder A",
    role: "Stale-memory implementation",
    status: "working",
    evidence: [
      {
        kind: "memory",
        id: staleMemoryId,
        label: "Active stale Remnic decision available to Builder A",
        locator: "recording://memories/stale.json",
        capture: "at_action",
      },
    ],
  });

  const scoutRaw = await execute("scout", scoutWorkspace);
  const scoutOutput = RelayScoutOutputSchema.parse(scoutRaw.output);
  await validateSourceGrounding(scoutWorkspace, scoutOutput.source_locators, scoutOutput.decision);
  if (scoutRaw.summary.recallToolCalls !== 0)
    throw new Error("Relay Scout must be grounded only in its synthetic source tree");
  const scout = sanitizedCall(scoutRaw, "scout", scoutOutput);
  calls.push(scout);
  await append({
    kind: "agent_output",
    agentId: "agent-scout",
    sessionId: "session-scout",
    outputId: "output-scout",
    summary: "The authoritative contract requires session-token reuse and one replacement after expiry.",
    evidence: [callEvidence("scout"), sourceEvidence()],
  });
  await append({
    kind: "belief_observed",
    agentId: "agent-scout",
    sessionId: "session-scout",
    beliefId: "belief-refresh-after-expiry",
    decisionId: RELAY_REPLACEMENT_DECISION_ID,
    statement: RELAY_CANONICAL_CHECKOUT_DECISION,
    confidence: scoutOutput.confidence,
    evidence: [sourceEvidence(), callEvidence("scout")],
  });

  const staleRaw = await execute("stale-builder", staleWorkspace);
  const staleOutput = RelayBuilderOutputSchema.parse(staleRaw.output);
  validateRecallOutput(staleOutput, staleRaw.summary, staleMemoryId, "stale");
  if (staleRaw.summary.recallToolCalls !== 1)
    throw new Error("Relay stale Builder must perform exactly one Remnic recall");
  await validateBuilderWorkspace(fixtureRoot, staleWorkspace, staleOutput, "stale");
  const stale = sanitizedCall(staleRaw, "stale-builder", staleOutput);
  calls.push(stale);
  await append({
    kind: "agent_output",
    agentId: "agent-stale-builder",
    sessionId: "session-stale-builder",
    outputId: "output-stale-builder",
    summary: "Builder A followed the active stale memory and rotated the token on every retry.",
    evidence: [callEvidence("stale-builder")],
  });
  await append({
    kind: "belief_observed",
    agentId: "agent-stale-builder",
    sessionId: "session-stale-builder",
    beliefId: "belief-new-token-every-request",
    decisionId: RELAY_STALE_DECISION_ID,
    statement: STALE_DECISION,
    confidence: 0.96,
    evidence: [
      {
        kind: "memory",
        id: staleMemoryId,
        label: "Active stale Remnic decision recalled at action time",
        locator: "recording://memories/stale.json",
        capture: "at_action",
      },
      callEvidence("stale-builder"),
    ],
  });
  await append({
    kind: "conflict_detected",
    conflictId: RELAY_CONFLICT_ID,
    decisionIds: [RELAY_REPLACEMENT_DECISION_ID, RELAY_STALE_DECISION_ID],
    agentIds: ["agent-scout", "agent-stale-builder"],
    summary: "Source truth and active shared memory disagree on whether checkout retries reuse or rotate the token.",
    evidence: [sourceEvidence(), callEvidence("scout"), callEvidence("stale-builder")],
  });
  const beforeTest = await runRelayHiddenContractTest(fixtureRoot, staleWorkspace, "before-correction");
  await append({
    kind: "test_result",
    testId: "test-before-correction",
    decisionId: RELAY_STALE_DECISION_ID,
    command: beforeTest.command,
    status: beforeTest.status,
    summary: beforeTest.summary,
    durationMs: beforeTest.durationMs,
    evidence: [testEvidence(), callEvidence("stale-builder")],
  });

  const resolverRaw = await execute("resolver", resolverWorkspace);
  const resolverOutput = RelayResolverOutputSchema.parse(resolverRaw.output);
  await validateSourceGrounding(resolverWorkspace, resolverOutput.source_locators, resolverOutput.replacement_decision);
  if (resolverRaw.summary.recallToolCalls !== 0)
    throw new Error("Relay Resolver must be grounded only in authoritative sources");
  const resolver = sanitizedCall(resolverRaw, "resolver", resolverOutput);
  calls.push(resolver);
  await append({
    kind: "correction_proposed",
    correctionId: RELAY_CORRECTION_ID,
    conflictId: RELAY_CONFLICT_ID,
    proposedDecisionId: RELAY_REPLACEMENT_DECISION_ID,
    supersedesDecisionIds: [RELAY_STALE_DECISION_ID],
    statement: RELAY_CANONICAL_CHECKOUT_DECISION,
    rationale: resolverOutput.rationale,
    proposedBy: "agent-resolver",
    evidence: [sourceEvidence(), testEvidence(), callEvidence("resolver")],
  });
  await append({
    kind: "correction_approved",
    correctionId: RELAY_CORRECTION_ID,
    approvedBy: {
      kind: "human",
      id: options.approval.operatorPrincipal,
      label: "Build Week operator",
    },
    note: "Explicit CLI approval accepted the source-grounded correction and authorized supersession.",
    evidence: [
      {
        kind: "approval",
        id: "approval-relay-build-week-operator",
        label: "Explicit human CLI approval gate",
        locator: "recording://approval.json",
        capture: "at_action",
      },
    ],
  });
  const correction = await options.harness.applyResolverCorrection(
    resolverOutput,
    staleMemoryId,
    options.approval.operatorPrincipal
  );
  const correctionSummary = correctionReceipt(correction);
  await append({
    kind: "decision_superseded",
    decisionId: RELAY_STALE_DECISION_ID,
    replacementDecisionId: RELAY_REPLACEMENT_DECISION_ID,
    correctionId: RELAY_CORRECTION_ID,
    evidence: [
      {
        kind: "correction",
        id: RELAY_CORRECTION_ID,
        label: "Applied Remnic Correction Contract supersession",
        locator: "recording://correction.json",
        capture: "at_action",
      },
      {
        kind: "correction",
        id: correctionSummary.planId,
        label: "Remnic correction plan receipt",
        locator: "recording://correction.json",
        capture: "at_action",
      },
    ],
  });

  await options.harness.proveMcpRecall(correction.replacementMemoryId, RELAY_COLD_PROBE_SESSION_KEY);
  const coldRaw = await execute("cold-builder", coldWorkspace);
  const coldOutput = RelayBuilderOutputSchema.parse(coldRaw.output);
  validateRecallOutput(coldOutput, coldRaw.summary, correction.replacementMemoryId, "cold");
  if (coldRaw.summary.recallToolCalls !== 1)
    throw new Error("Relay cold Builder must perform exactly one Remnic recall");
  await validateBuilderWorkspace(fixtureRoot, coldWorkspace, coldOutput, "cold");
  const cold = sanitizedCall(coldRaw, "cold-builder", coldOutput);
  calls.push(cold);
  await append({
    kind: "recall_observed",
    agentId: "agent-cold-builder",
    sessionId: `session-${cold.summary.threadId}`,
    recallReceiptId: "recall-cold-builder",
    decisionId: RELAY_REPLACEMENT_DECISION_ID,
    query: RELAY_QUERY,
    capturedAtAction: true,
    evidence: [
      {
        kind: "recall_audit",
        id: "recall-cold-builder",
        label: "Transcript-free cold Builder recall",
        locator: "recording://calls/cold-builder.json",
        capture: "at_action",
      },
      {
        kind: "memory",
        id: correction.replacementMemoryId,
        label: "Active replacement Remnic decision",
        locator: "recording://memories/replacement.json",
        capture: "at_action",
      },
    ],
  });
  await append({
    kind: "propagation_verified",
    agentId: "agent-cold-builder",
    sessionId: `session-${cold.summary.threadId}`,
    correctionId: RELAY_CORRECTION_ID,
    decisionId: RELAY_REPLACEMENT_DECISION_ID,
    recallReceiptId: "recall-cold-builder",
    staleDecisionAbsent: !correction.recall.memoryIds.includes(staleMemoryId),
    evidence: [
      {
        kind: "recall_audit",
        id: "recall-cold-builder",
        label: "Transcript-free cold Builder recall",
        locator: "recording://calls/cold-builder.json",
        capture: "at_action",
      },
      {
        kind: "correction",
        id: RELAY_CORRECTION_ID,
        label: "Applied Remnic Correction Contract supersession",
        locator: "recording://correction.json",
        capture: "at_action",
      },
    ],
  });
  const afterTest = await runRelayHiddenContractTest(fixtureRoot, coldWorkspace, "after-correction");
  await append({
    kind: "test_result",
    testId: "test-after-correction",
    decisionId: RELAY_REPLACEMENT_DECISION_ID,
    correctionId: RELAY_CORRECTION_ID,
    command: afterTest.command,
    status: afterTest.status,
    summary: afterTest.summary,
    durationMs: afterTest.durationMs,
    evidence: [
      testEvidence(),
      callEvidence("cold-builder"),
      {
        kind: "correction",
        id: RELAY_CORRECTION_ID,
        label: "Applied Remnic Correction Contract supersession",
        locator: "recording://correction.json",
        capture: "at_action",
      },
    ],
  });
  await append({
    kind: "mission_completed",
    outcome: "recovered",
    summary:
      "One human-approved correction reached a fresh GPT-5.6 thread and changed a hidden contract from fail to pass.",
    evidence: [
      testEvidence(),
      {
        kind: "approval",
        id: "approval-relay-build-week-operator",
        label: "Explicit human CLI approval gate",
        locator: "recording://approval.json",
        capture: "at_action",
      },
    ],
  });

  if (calls.length !== RELAY_MAX_LIVE_CALLS || threadIds.size !== RELAY_MAX_LIVE_CALLS) {
    throw new Error("Relay mission did not complete exactly four fresh one-shot Codex calls");
  }
  const mission = await store.read(RELAY_MISSION_ID, { limit: 200 });
  if (!mission.receipt.complete || mission.receipt.missingEvidence.length !== 0 || mission.events.length !== 16) {
    throw new Error(`Relay core rejected the live mission receipt: ${mission.receipt.missingEvidence.join(", ")}`);
  }
  if (!mission.receipt.coldStartVerified || !mission.receipt.passingOutcomeVerified) {
    throw new Error("Relay core did not verify cold-start propagation and the recovered outcome");
  }

  return {
    fixtureManifestSha256: fixtureManifest.rootSha256,
    mission,
    missionReceiptSha256: relayMissionReceiptDigest(mission),
    calls: [scout, stale, resolver, cold],
    tests: [beforeTest, afterTest],
    staleMemoryId,
    replacementMemoryId: correction.replacementMemoryId,
    correction: correctionSummary,
    approval: { approved: true, operatorPrincipal: options.approval.operatorPrincipal },
  };
}
