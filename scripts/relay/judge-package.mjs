import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_RELAY_REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
export const RELAY_RECORDING_ROOT_SHA256 = "e5dc82d98118120171e2a4a9c7a5e87de966e86c8ee7cfa59e30e4545be16a6e";
export const RELAY_UI_ROOT_SHA256 = "e202cc6463501b5089b82b090d86c7d566969ba3e09451a441831fe5c0b5e0b4";

const RECORDING_RELATIVE = "docs/remnic-relay/recordings/gpt-5-6-checkout-recovery";
const FIXTURE_RELATIVE = "fixtures/remnic-relay";
const UI_RELATIVE = "admin-console/public/relay";
const DEMO_SCRIPT_RELATIVE = "docs/remnic-relay/DEMO-SCRIPT.md";
const DEMO_SPEAKING_RATE_WPM = 145;
const DEMO_ACTION_ALLOWANCE_SECONDS = 30;
const DEMO_MAX_SECONDS = 179;
const MODEL = "gpt-5.6-terra";
const REASONING_EFFORT = "medium";
const MISSION_ID = "checkout-token-recovery";
const NAMESPACE = "relay-build-week";
const STALE_DECISION_ID = "decision-new-token-every-request";
const REPLACEMENT_DECISION_ID = "decision-refresh-after-expiry";
const CORRECTION_ID = "correction-token-refresh";
const CHANGED_FILE = "src/token-policy.mjs";
const ROLE_ORDER = ["scout", "stale-builder", "resolver", "cold-builder"];
const EXPECTED_EVENT_KINDS = [
  "mission_started",
  "agent_status",
  "agent_status",
  "agent_output",
  "belief_observed",
  "agent_output",
  "belief_observed",
  "conflict_detected",
  "test_result",
  "correction_proposed",
  "correction_approved",
  "decision_superseded",
  "recall_observed",
  "propagation_verified",
  "test_result",
  "mission_completed",
];
const EXPECTED_FRAME_IDS = [
  "mission",
  "agents",
  "beliefs",
  "conflict",
  "failure",
  "proposal",
  "approval",
  "superseded",
  "cold-recall",
  "propagated",
  "passing",
  "receipt",
];
const EXPECTED_RECORDING_FILES = [
  "approval.json",
  "budget-adjustment.json",
  "calls/cold-builder.json",
  "calls/resolver.json",
  "calls/scout.json",
  "calls/stale-builder.json",
  "correction.json",
  "credit-receipt.json",
  "events.json",
  "memories/replacement.json",
  "memories/stale.json",
  "mission-receipt.json",
  "preflight.json",
  "recording.json",
  "tests.json",
];
const EXPECTED_UI_FILES = ["index.html", "relay-model.js", "relay.css", "relay.js", "replay.json"];
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invariant(condition, message) {
  if (!condition) throw new Error(`Relay judge verification failed: ${message}`);
}

function asObject(value, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function asArray(value, label) {
  invariant(Array.isArray(value), `${label} must be an array`);
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function readJson(root, relative) {
  const file = path.join(root, relative);
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`Relay judge verification failed: cannot parse ${relative}`, { cause: error });
  }
}

async function regularFiles(root) {
  const rootInfo = await lstat(root);
  invariant(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), `${root} must be a real directory`);
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = (await readdir(current, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name)
    );
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      const info = await lstat(entryPath);
      invariant(!info.isSymbolicLink(), `${path.relative(root, entryPath)} must not be a symlink`);
      if (info.isDirectory()) pending.push(entryPath);
      else {
        invariant(info.isFile(), `${path.relative(root, entryPath)} must be a regular file`);
        files.push(entryPath);
      }
    }
  }
  return files.sort();
}

async function digestTree(root, excluded = []) {
  const excludedSet = new Set(excluded);
  const digests = [];
  for (const file of await regularFiles(root)) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (excludedSet.has(relative)) continue;
    const contents = await readFile(file);
    digests.push({ path: relative, bytes: contents.byteLength, sha256: sha256(contents) });
  }
  return digests;
}

async function readTextTree(root) {
  return Promise.all((await regularFiles(root)).map((file) => readFile(file, "utf8")));
}

async function verifyManifest(root, expectedFiles) {
  const manifest = asObject(await readJson(root, "manifest.json"), "manifest.json");
  const files = await digestTree(root, ["manifest.json"]);
  const actual = { schemaVersion: 1, files, rootSha256: sha256(JSON.stringify(files)) };
  invariant(sameJson(manifest, actual), "the recording integrity manifest does not match its bytes");
  invariant(
    sameJson(
      files.map((item) => item.path),
      expectedFiles
    ),
    "the recording file set is incomplete or unexpected"
  );
  return actual;
}

async function verifyFixtureManifest(repoRoot) {
  const fixtureRoot = path.join(repoRoot, FIXTURE_RELATIVE);
  const manifest = asObject(await readJson(fixtureRoot, "manifest.json"), "fixture manifest");
  const files = await digestTree(fixtureRoot, ["manifest.json"]);
  const actual = { schemaVersion: 1, files, rootSha256: sha256(JSON.stringify(files)) };
  invariant(sameJson(manifest, actual), "the committed synthetic fixture manifest does not match its bytes");
  return actual;
}

function usageOf(summary, label) {
  const usage = asObject(summary.usage, `${label}.usage`);
  for (const key of ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens"]) {
    invariant(Number.isInteger(usage[key]) && usage[key] >= 0, `${label}.usage.${key} must be a nonnegative integer`);
  }
  invariant(usage.cachedInputTokens <= usage.inputTokens, `${label} cached input cannot exceed input`);
  return usage;
}

function terraBudgetNanounits(usage) {
  const cached = BigInt(usage.cachedInputTokens);
  const uncached = BigInt(usage.inputTokens - usage.cachedInputTokens);
  return uncached * 62_500n + cached * 6_250n + BigInt(usage.outputTokens) * 375_000n;
}

function unitsToNanounits(value, label) {
  invariant(typeof value === "number" && Number.isFinite(value) && value >= 0, `${label} must be nonnegative`);
  return BigInt(Math.round(value * 1_000_000_000));
}

function assertCorrectDecision(value, label) {
  invariant(typeof value === "string", `${label} must be text`);
  const normalized = value.toLowerCase();
  invariant(/reuse/.test(normalized), `${label} must require token reuse`);
  invariant(
    /(?:ordinary )?retr(?:y|ies)/.test(normalized) || /while (?:it is |the token is )?valid/.test(normalized),
    `${label} must require reuse for ordinary retries or while valid`
  );
  invariant(/exactly one replacement/.test(normalized), `${label} must require exactly one replacement`);
  invariant(/expir/.test(normalized), `${label} must bind replacement to expiry`);
  const mentionsEveryRequest = /every (?:checkout )?request/.test(normalized);
  const explicitlyRejectsEveryRequest =
    /(?:do not|don't|never).{0,40}(?:rotate|mint|create|issue).{0,40}every (?:checkout )?request/.test(normalized);
  invariant(!mentionsEveryRequest || explicitlyRejectsEveryRequest, `${label} must reject per-request rotation`);
}

function assertStaleDecision(value, label) {
  invariant(typeof value === "string", `${label} must be text`);
  const normalized = value.toLowerCase();
  invariant(/mint|create|issue|rotate/.test(normalized), `${label} must rotate the token`);
  invariant(/every (?:checkout )?request/.test(normalized), `${label} must cover every request`);
  invariant(/every (?:ordinary )?retr(?:y|ies)/.test(normalized), `${label} must cover every retry`);
}

function canonicalModelOutput(role, value) {
  const output = asObject(value, `${role} output`);
  if (role === "scout") {
    return {
      decision: output.decision,
      rationale: output.rationale,
      source_locators: output.source_locators,
      confidence: output.confidence,
    };
  }
  if (role === "resolver") {
    return {
      replacement_decision: output.replacement_decision,
      rationale: output.rationale,
      source_locators: output.source_locators,
      confidence: output.confidence,
    };
  }
  return {
    summary: output.summary,
    decision_applied: output.decision_applied,
    files_changed: output.files_changed,
    tests_run: output.tests_run,
  };
}

function assertSourceAgent(role, output) {
  const decision = role === "scout" ? output.decision : output.replacement_decision;
  assertCorrectDecision(decision, `${role} source decision`);
  invariant(
    sameJson(output.source_locators, [
      "CONTRACT.md",
      "src/reference-token-policy.mjs",
      "test/token-policy.contract.test.mjs",
    ]),
    `${role} must cite the exact sealed source set`
  );
  invariant(typeof output.rationale === "string" && output.rationale.length > 0, `${role} rationale is missing`);
  invariant(
    typeof output.confidence === "number" && output.confidence >= 0 && output.confidence <= 1,
    `${role} confidence is invalid`
  );
}

function assertBuilder(role, call, expectedMemoryId) {
  const output = asObject(call.output, `${role} output`);
  const stale = role === "stale-builder";
  if (stale) assertStaleDecision(output.decision_applied, `${role} decision`);
  else assertCorrectDecision(output.decision_applied, `${role} decision`);
  invariant(sameJson(output.files_changed, [CHANGED_FILE]), `${role} must name only ${CHANGED_FILE}`);
  invariant(
    asArray(output.tests_run, `${role}.tests_run`).some((item) => /npm\s+test/i.test(String(item))),
    `${role} must report its npm test attempt`
  );
  invariant(output.recall_memory_id === expectedMemoryId, `${role} output is not bound to its recalled memory`);
  const summary = call.summary;
  invariant(summary.recallToolCalls === 1, `${role} must make exactly one Remnic recall`);
  const recall = asObject(summary.recallReceipt, `${role} recall receipt`);
  invariant(recall.query === "checkout token retry policy decision", `${role} recall query drifted`);
  invariant(recall.namespace === NAMESPACE, `${role} recall namespace drifted`);
  invariant(
    recall.sessionKey === (stale ? "relay:builder-a:transcript-free" : "relay:builder-cold:transcript-free"),
    `${role} session key drifted`
  );
  invariant(sameJson(recall.memoryIds, [expectedMemoryId]), `${role} recall receipt is not bound to its memory`);
}

function scanForSensitiveMaterial(values) {
  const text = values.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join("\n");
  const forbidden = [
    /\/home\//,
    /\.codex\/auth\.json/,
    /\bBearer\s+[A-Za-z0-9._-]{16,}/i,
    /\bsk-[A-Za-z0-9_-]{16,}\b/,
    /REMNIC_RELAY_MCP_TOKEN/,
    /OPENAI_API_KEY/,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  ];
  invariant(
    !forbidden.some((pattern) => pattern.test(text)),
    "the judge package contains secret-like or host-private material"
  );
}

function measureDemoScript(contents) {
  const match = contents.match(/<!-- narration:start -->([\s\S]*?)<!-- narration:end -->/);
  invariant(match, "the demo script must contain one measured narration block");
  const words = match[1].match(/[A-Za-z0-9]+(?:[.’'-][A-Za-z0-9]+)*/g) ?? [];
  invariant(words.length > 0, "the measured demo narration is empty");
  const narrationSeconds = Math.ceil((words.length / DEMO_SPEAKING_RATE_WPM) * 60);
  const estimatedTotalSeconds = narrationSeconds + DEMO_ACTION_ALLOWANCE_SECONDS;
  invariant(estimatedTotalSeconds <= DEMO_MAX_SECONDS, "the measured demo script exceeds three minutes");
  return {
    words: words.length,
    speakingRateWpm: DEMO_SPEAKING_RATE_WPM,
    narrationSeconds,
    actionAllowanceSeconds: DEMO_ACTION_ALLOWANCE_SECONDS,
    estimatedTotalSeconds,
  };
}

export async function verifyRelayJudgePackage(repoRoot = DEFAULT_RELAY_REPO_ROOT) {
  const root = path.resolve(repoRoot);
  const recordingRoot = path.join(root, RECORDING_RELATIVE);
  const uiRoot = path.join(root, UI_RELATIVE);
  const [manifest, fixtureManifest, uiFiles] = await Promise.all([
    verifyManifest(recordingRoot, EXPECTED_RECORDING_FILES),
    verifyFixtureManifest(root),
    digestTree(uiRoot),
  ]);
  invariant(manifest.rootSha256 === RELAY_RECORDING_ROOT_SHA256, "the canonical recording root changed without review");
  const uiRootSha256 = sha256(JSON.stringify(uiFiles));
  invariant(uiRootSha256 === RELAY_UI_ROOT_SHA256, "the Mission Control UI root changed without review");

  const [
    metadata,
    preflight,
    creditReceipt,
    budgetAdjustment,
    events,
    tests,
    approval,
    correction,
    staleMemory,
    replacementMemory,
    missionReceipt,
    replay,
  ] = await Promise.all([
    readJson(recordingRoot, "recording.json"),
    readJson(recordingRoot, "preflight.json"),
    readJson(recordingRoot, "credit-receipt.json"),
    readJson(recordingRoot, "budget-adjustment.json"),
    readJson(recordingRoot, "events.json"),
    readJson(recordingRoot, "tests.json"),
    readJson(recordingRoot, "approval.json"),
    readJson(recordingRoot, "correction.json"),
    readJson(recordingRoot, "memories/stale.json"),
    readJson(recordingRoot, "memories/replacement.json"),
    readJson(recordingRoot, "mission-receipt.json"),
    readJson(uiRoot, "replay.json"),
  ]);

  asObject(metadata, "recording.json");
  asObject(preflight, "preflight.json");
  asObject(creditReceipt, "credit-receipt.json");
  asObject(budgetAdjustment, "budget-adjustment.json");
  asObject(approval, "approval.json");
  asObject(correction, "correction.json");
  asObject(staleMemory, "stale memory");
  asObject(replacementMemory, "replacement memory");
  asObject(missionReceipt, "mission receipt");
  asObject(replay, "replay.json");
  asArray(events, "events.json");
  asArray(tests, "tests.json");

  invariant(metadata.model === MODEL && metadata.reasoningEffort === REASONING_EFFORT, "recorded model policy drifted");
  invariant(sameJson(metadata.callOrder, ROLE_ORDER), "recorded call order drifted");
  invariant(sameJson(metadata.testTransition, ["failed", "passed"]), "recorded fail-to-pass transition drifted");
  invariant(
    metadata.fixtureManifestSha256 === fixtureManifest.rootSha256,
    "recording is not bound to committed synthetic fixtures"
  );
  invariant(
    metadata.missionReceiptSha256 === missionReceipt.missionReceiptSha256,
    "recording and mission receipt disagree"
  );
  invariant(
    metadata.evidence?.syntheticFixturesOnly === true &&
      metadata.evidence?.productionDataRead === false &&
      metadata.evidence?.transcriptsShared === false &&
      metadata.evidence?.promptsRecorded === false &&
      metadata.evidence?.rawJsonlRecorded === false &&
      metadata.evidence?.integrityManifest === true,
    "recording privacy policy is not the strict synthetic-only policy"
  );
  invariant(
    preflight.productionDataRead === false && preflight.solAllowed === false,
    "preflight privacy/model policy drifted"
  );

  invariant(
    staleMemory.synthetic === true && staleMemory.status === "superseded",
    "stale memory is not synthetic and superseded"
  );
  invariant(staleMemory.decisionId === STALE_DECISION_ID, "stale memory decision ID drifted");
  assertStaleDecision(staleMemory.statement, "stale memory");
  invariant(
    replacementMemory.synthetic === true && replacementMemory.status === "active",
    "replacement memory is not synthetic and active"
  );
  invariant(replacementMemory.decisionId === REPLACEMENT_DECISION_ID, "replacement memory decision ID drifted");
  assertCorrectDecision(replacementMemory.statement, "replacement memory");
  invariant(
    correction.correctionId === CORRECTION_ID &&
      correction.staleMemoryId === staleMemory.memoryId &&
      correction.replacementMemoryId === replacementMemory.memoryId &&
      correction.staleMemoryStatus === "superseded" &&
      correction.outcomeStatus === "applied",
    "correction artifact is not bound to the memory transition"
  );
  invariant(
    approval.approved === true &&
      approval.operatorPrincipal === "relay-build-week-operator" &&
      approval.gate === "--approve-correction APPROVE",
    "human approval artifact drifted"
  );

  const calls = {};
  for (const role of ROLE_ORDER) {
    const call = asObject(await readJson(recordingRoot, `calls/${role}.json`), `${role} call`);
    const summary = asObject(call.summary, `${role} summary`);
    invariant(summary.role === role, `${role} artifact has the wrong role`);
    invariant(summary.model === MODEL && summary.reasoningEffort === REASONING_EFFORT, `${role} model policy drifted`);
    invariant(summary.status === "completed" && summary.exitCode === 0, `${role} did not complete successfully`);
    invariant(UUID_PATTERN.test(summary.threadId), `${role} thread ID is invalid`);
    invariant(
      SHA256_PATTERN.test(summary.promptSha256) && SHA256_PATTERN.test(summary.outputSha256),
      `${role} digests are invalid`
    );
    const canonicalOutput = canonicalModelOutput(role, call.output);
    invariant(
      summary.outputSha256 === sha256(JSON.stringify(canonicalOutput)),
      `${role} retained output digest does not match`
    );
    usageOf(summary, role);
    calls[role] = call;
  }
  const threadIds = ROLE_ORDER.map((role) => calls[role].summary.threadId);
  invariant(new Set(threadIds).size === ROLE_ORDER.length, "the four Codex calls do not use distinct threads");
  invariant(sameJson(metadata.threadIds, threadIds), "recording thread IDs are not bound to the call artifacts");
  assertSourceAgent("scout", calls.scout.output);
  assertSourceAgent("resolver", calls.resolver.output);
  invariant(
    calls.scout.summary.recallToolCalls === 0 && calls.scout.summary.recallReceipt === null,
    "Scout unexpectedly used memory recall"
  );
  invariant(
    calls.resolver.summary.recallToolCalls === 0 && calls.resolver.summary.recallReceipt === null,
    "Resolver unexpectedly used memory recall"
  );
  assertBuilder("stale-builder", calls["stale-builder"], staleMemory.memoryId);
  assertBuilder("cold-builder", calls["cold-builder"], replacementMemory.memoryId);

  const promptFiles = {
    scout: "scout.md",
    "stale-builder": "stale-builder.md",
    resolver: "resolver.md",
    "cold-builder": "cold-builder.md",
  };
  for (const role of ROLE_ORDER) {
    const prompt = await readFile(path.join(root, FIXTURE_RELATIVE, "prompts", promptFiles[role]));
    invariant(calls[role].summary.promptSha256 === sha256(prompt), `${role} is not bound to its committed prompt`);
  }

  invariant(tests.length === 2, "exactly two hidden-contract test results are required");
  invariant(
    tests[0]?.phase === "before-correction" && tests[0]?.status === "failed" && tests[0]?.exitCode !== 0,
    "before-correction test does not prove failure"
  );
  invariant(
    tests[1]?.phase === "after-correction" && tests[1]?.status === "passed" && tests[1]?.exitCode === 0,
    "after-correction test does not prove recovery"
  );

  invariant(events.length === EXPECTED_EVENT_KINDS.length, "the mission must contain exactly 16 causal events");
  invariant(
    sameJson(
      events.map((event) => event?.payload?.kind),
      EXPECTED_EVENT_KINDS
    ),
    "causal event order drifted"
  );
  for (const event of events) {
    invariant(
      event.missionId === MISSION_ID && event.namespace === NAMESPACE,
      "an event escaped the sealed mission scope"
    );
    invariant(
      event.authenticatedPrincipal === "relay-build-week-operator",
      "an event lacks the sealed operator principal"
    );
  }
  const before = events[8].payload;
  const approved = events[10].payload;
  const superseded = events[11].payload;
  const recalled = events[12].payload;
  const propagated = events[13].payload;
  const after = events[14].payload;
  const completed = events[15].payload;
  const coldSession = `session-${calls["cold-builder"].summary.threadId}`;
  invariant(
    before.status === "failed" && before.decisionId === STALE_DECISION_ID,
    "failure event is not bound to the stale decision"
  );
  invariant(approved.correctionId === CORRECTION_ID && approved.approvedBy?.kind === "human", "approval event drifted");
  invariant(
    superseded.decisionId === STALE_DECISION_ID && superseded.replacementDecisionId === REPLACEMENT_DECISION_ID,
    "supersession event drifted"
  );
  for (const payload of [recalled, propagated]) {
    invariant(
      payload.agentId === "agent-cold-builder" &&
        payload.sessionId === coldSession &&
        payload.decisionId === REPLACEMENT_DECISION_ID,
      `${payload.kind} is not bound to the cold Builder thread`
    );
  }
  invariant(propagated.staleDecisionAbsent === true, "propagation does not prove the stale decision is absent");
  invariant(
    after.status === "passed" && after.decisionId === REPLACEMENT_DECISION_ID,
    "passing event is not bound to the replacement decision"
  );
  invariant(completed.outcome === "recovered", "mission did not complete as recovered");
  invariant(
    missionReceipt.complete === true &&
      missionReceipt.coldStartVerified === true &&
      missionReceipt.passingOutcomeVerified === true &&
      missionReceipt.outcome === "recovered" &&
      sameJson(missionReceipt.activeDecisionIds, [REPLACEMENT_DECISION_ID]) &&
      sameJson(missionReceipt.supersededDecisionIds, [STALE_DECISION_ID]),
    "mission receipt does not prove cold-start recovery"
  );

  const run = asObject(creditReceipt.run, "credit receipt run");
  const totals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
  let budgetNanounits = 0n;
  for (const role of ROLE_ORDER) {
    const usage = usageOf(calls[role].summary, role);
    for (const key of Object.keys(totals)) totals[key] += usage[key];
    budgetNanounits += terraBudgetNanounits(usage);
  }
  invariant(
    run.calls === 4 && run.models?.length === 1,
    "credit receipt must contain four calls and one model aggregate"
  );
  const modelScope = asObject(run.models[0], "credit model aggregate");
  invariant(modelScope.model === MODEL && modelScope.calls === 4, "credit model aggregate drifted");
  for (const key of Object.keys(totals)) {
    invariant(run[key] === totals[key] && modelScope[key] === totals[key], `credit ${key} is not bound to call usage`);
  }
  invariant(
    unitsToNanounits(run.budgetUnits, "run budget") === budgetNanounits &&
      unitsToNanounits(modelScope.budgetUnits, "model budget") === budgetNanounits,
    "credit spend is not independently reproducible from call usage"
  );
  invariant(
    run.accountBalanceResolutionCount === 0 && run.conservativeResolutionChargeUnits === 0,
    "run includes an account-balance resolution charge"
  );
  invariant(metadata.creditUnitsSpentByRun === run.budgetUnits, "recording metadata and credit receipt spend disagree");
  invariant(
    creditReceipt.budgetUnits === 2173 &&
      creditReceipt.reserveUnits === 473 &&
      creditReceipt.plannedSpendCeilingUnits === 1700 &&
      budgetAdjustment.accountCreditCapUnits === 2473 &&
      budgetAdjustment.effectiveBudgetUnits === 2173,
    "bounded-credit policy drifted"
  );

  invariant(
    replay.schemaVersion === "1" && replay.missionId === MISSION_ID && replay.namespace === NAMESPACE,
    "UI replay scope drifted"
  );
  invariant(
    replay.source === `integrity-checked Remnic Relay recording sha256:${manifest.rootSha256}`,
    "UI replay is not bound to the recording root"
  );
  invariant(
    replay.generatedAt === metadata.generatedAt && replay.initialFrameId === "conflict",
    "UI replay metadata drifted"
  );
  invariant(
    sameJson(
      replay.frames?.map((frame) => frame.id),
      EXPECTED_FRAME_IDS
    ),
    "UI replay frame sequence drifted"
  );
  const finalFrame = replay.frames.at(-1)?.snapshot;
  invariant(sameJson(finalFrame?.events, events), "UI final frame is not bound to the sealed event trace");
  invariant(
    finalFrame?.receipt?.complete === true &&
      finalFrame?.receipt?.coldStartVerified === true &&
      finalFrame?.receipt?.passingOutcomeVerified === true &&
      finalFrame?.outcome?.result === "recovered",
    "UI final frame does not show the sealed recovery"
  );

  const recomputedMissionReceiptSha256 = sha256(
    stableJson({
      schemaVersion: finalFrame.schemaVersion,
      missionId: finalFrame.missionId,
      namespace: finalFrame.namespace,
      status: finalFrame.status,
      decisions: finalFrame.decisions,
      corrections: finalFrame.corrections,
      propagation: finalFrame.propagation,
      tests: finalFrame.tests,
      outcome: finalFrame.outcome,
      receipt: finalFrame.receipt,
    })
  );
  invariant(
    recomputedMissionReceiptSha256 === missionReceipt.missionReceiptSha256 &&
      recomputedMissionReceiptSha256 === metadata.missionReceiptSha256,
    "mission receipt digest is not independently reproducible from the final snapshot"
  );

  invariant(
    sameJson(
      uiFiles.map((file) => file.path),
      [...EXPECTED_UI_FILES].sort()
    ),
    "judge UI file set is incomplete or unexpected"
  );
  const [staticAssets, demoScript, recordingText, fixtureText, packageManifest] = await Promise.all([
    Promise.all(EXPECTED_UI_FILES.map((name) => readFile(path.join(uiRoot, name), "utf8"))),
    readFile(path.join(root, DEMO_SCRIPT_RELATIVE), "utf8"),
    readTextTree(recordingRoot),
    readTextTree(path.join(root, FIXTURE_RELATIVE)),
    readFile(path.join(root, "package.json"), "utf8"),
  ]);
  const sensitiveFilesScanned = recordingText.length + fixtureText.length + staticAssets.length + 2;
  scanForSensitiveMaterial([...recordingText, ...fixtureText, ...staticAssets, demoScript, packageManifest]);
  const demo = measureDemoScript(demoScript);

  const startedAt = Date.parse(events[0].occurredAt);
  const completedAt = Date.parse(events.at(-1).occurredAt);
  invariant(
    Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt >= startedAt,
    "mission timestamps are invalid"
  );

  return {
    status: "verified",
    mode: "offline-sealed-live-replay",
    missionId: MISSION_ID,
    recordingSha256: manifest.rootSha256,
    uiSha256: uiRootSha256,
    missionReceiptSha256: missionReceipt.missionReceiptSha256,
    fixtureManifestSha256: fixtureManifest.rootSha256,
    model: MODEL,
    reasoningEffort: REASONING_EFFORT,
    calls: 4,
    distinctThreads: 4,
    missionDurationMs: completedAt - startedAt,
    creditUnitsSpent: run.budgetUnits,
    testTransition: ["failed", "passed"],
    humanApproved: true,
    coldStartVerified: true,
    productionDataRead: false,
    syntheticFixturesOnly: true,
    externalCalls: 0,
    runtimeDependencies: 0,
    sensitiveFilesScanned,
    demo,
  };
}

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function responseHeaders(contentType) {
  return {
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    "content-type": contentType,
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections?.();
  });
}

export async function startRelayJudgeServer(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_RELAY_REPO_ROOT);
  const host = "127.0.0.1";
  const port = options.port ?? 4173;
  invariant(
    Number.isInteger(port) && port >= 0 && port <= 65_535,
    "server port must be an integer from 0 through 65535"
  );
  const receipt = await verifyRelayJudgePackage(repoRoot);
  const uiRoot = path.join(repoRoot, UI_RELATIVE);
  const routes = new Map([
    ["/", "index.html"],
    ["/index.html", "index.html"],
    ["/relay.css", "relay.css"],
    ["/relay.js", "relay.js"],
    ["/relay-model.js", "relay-model.js"],
    ["/replay.json", "replay.json"],
  ]);
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { ...responseHeaders("text/plain; charset=utf-8"), allow: "GET, HEAD" });
        response.end("Method not allowed\n");
        return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/healthz" || url.pathname === "/judge-receipt.json") {
        const body = `${JSON.stringify(receipt, null, 2)}\n`;
        response.writeHead(200, responseHeaders("application/json; charset=utf-8"));
        response.end(request.method === "HEAD" ? undefined : body);
        return;
      }
      const asset = routes.get(url.pathname);
      if (!asset) {
        response.writeHead(404, responseHeaders("text/plain; charset=utf-8"));
        response.end("Not found\n");
        return;
      }
      const file = path.join(uiRoot, asset);
      const info = await lstat(file);
      invariant(info.isFile() && !info.isSymbolicLink(), `judge asset ${asset} must be a regular file`);
      const body = await readFile(file);
      response.writeHead(200, responseHeaders(CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream"));
      response.end(request.method === "HEAD" ? undefined : body);
    } catch (error) {
      response.writeHead(500, responseHeaders("text/plain; charset=utf-8"));
      response.end(`Relay judge server error: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  invariant(address && typeof address === "object", "judge server did not expose a TCP address");
  return {
    receipt,
    url: `http://${host}:${address.port}/`,
    close: () => closeServer(server),
  };
}

function parseCli(argv) {
  let command = "verify";
  let repoRoot = DEFAULT_RELAY_REPO_ROOT;
  let port = 4173;
  let json = false;
  let index = 0;
  if (argv[0] === "verify" || argv[0] === "serve") {
    command = argv[0];
    index = 1;
  }
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--root requires a directory");
      repoRoot = path.resolve(value);
      index += 1;
    } else if (arg === "--port") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--port requires an integer from 1 through 65535");
      port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65_535)
        throw new Error("--port requires an integer from 1 through 65535");
      index += 1;
    } else if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: node scripts/relay/judge-package.mjs [verify|serve] [--root <checkout>] [--port <1-65535>] [--json]\n"
      );
      process.exit(0);
    } else throw new Error(`Unknown Relay judge argument: ${arg}`);
  }
  return { command, repoRoot, port, json };
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.command === "verify") {
    const receipt = await verifyRelayJudgePackage(options.repoRoot);
    if (options.json) process.stdout.write(`${JSON.stringify(receipt)}\n`);
    else {
      process.stdout.write(
        `RELAY_JUDGE_PACKAGE_OK root=${receipt.recordingSha256} ui=${receipt.uiSha256} model=${receipt.model} calls=${receipt.calls} ` +
          `transition=${receipt.testTransition.join("->")} externalCalls=${receipt.externalCalls} productionDataRead=${receipt.productionDataRead}\n`
      );
    }
    return;
  }
  const running = await startRelayJudgeServer({ repoRoot: options.repoRoot, port: options.port });
  process.stdout.write(
    `RELAY_JUDGE_PACKAGE_OK root=${running.receipt.recordingSha256} ui=${running.receipt.uiSha256} model=${running.receipt.model} calls=${running.receipt.calls}\nRemnic Relay Mission Control: ${running.url}\nVerified offline replay · zero credentials · zero external calls · Ctrl+C to stop\n`
  );
  const stop = async () => {
    await running.close().catch(() => undefined);
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
