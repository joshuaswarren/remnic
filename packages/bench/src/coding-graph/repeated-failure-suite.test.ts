import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  computeRepeatedFailureModelProfileHash,
  createRepeatedFailureProfileDriver,
  replayRepeatedFailureStatistics,
  runRepeatedFailureSuite,
} from "./repeated-failure-suite.ts";
import { parseRepeatedFailureEpisodeRow } from "./repeated-failure-store.ts";
import type { ControlledResponsesEpisodeResult } from "./repeated-failure-responses-driver.ts";
import type {
  RepeatedFailureEpisodeDriver,
  RepeatedFailureEpisodeInput,
  RepeatedFailureProposedAction,
  RepeatedFailureTokenUsage,
} from "./repeated-failure-types.ts";

const TASK_ID = "h6-task-01";
const VARIANT_ID = "h6-task-01-v1";
const PROFILE_HASH = "1".repeat(64);
const FIXED_NOW = () => new Date("2026-01-02T00:00:00.000Z");
const FIXED_CLOCK = () => 100;
const MAIN_TASK_IDS = Object.freeze([
  "h6-task-03", "h6-task-04", "h6-task-05", "h6-task-08", "h6-task-09", "h6-task-10",
  "h6-task-13", "h6-task-14", "h6-task-15", "h6-task-18", "h6-task-19", "h6-task-20",
  "h6-task-23", "h6-task-24", "h6-task-25", "h6-task-28", "h6-task-29", "h6-task-30",
]);

test("immutable profile hash binds prompts, tools, tokenizer, decoding, and native Ollama endpoint", () => {
  const profile = {
    schemaVersion: 2,
    id: "local-8b",
    provider: "ollama-chat",
    model: "qwen3:8b",
    endpoint: "http://127.0.0.1:11434/api/chat",
    instructions: { system: "system contract", developer: "developer contract" },
    tokenizer: { identity: "qwen3-nfkc-v1", implementation: "nfkc-whitespace-v1" },
    contextWindowTokens: 131_072,
    temperature: 0,
    maxOutputTokens: 8_192,
    think: false,
    seedCapability: { kind: "options_parameter", requestField: "seed" },
  } as const;
  const contract = {
    prompt: { version: 1, text: "frozen prompt" },
    tools: [{ name: "apply_strategy", strict: true, parameters: { type: "object" } }],
    caps: { maxTurns: 8, maxToolCalls: 6, maxTotalTokens: 65_536 },
  };
  const hash = computeRepeatedFailureModelProfileHash(profile, contract);

  assert.notEqual(
    hash,
    computeRepeatedFailureModelProfileHash(profile, {
      ...contract,
      prompt: { version: 1, text: "changed prompt" },
    }),
  );
  assert.notEqual(
    hash,
    computeRepeatedFailureModelProfileHash(profile, {
      ...contract,
      tools: [{ ...contract.tools[0], strict: false }],
    }),
  );
  assert.notEqual(
    hash,
    computeRepeatedFailureModelProfileHash({
      ...profile,
      tokenizer: { ...profile.tokenizer, identity: "qwen3-nfkc-v2" },
    }, contract),
  );
  assert.notEqual(
    hash,
    computeRepeatedFailureModelProfileHash(profile, {
      ...contract,
      caps: { ...contract.caps, maxTurns: 9 },
    }),
  );
  assert.notEqual(
    hash,
    computeRepeatedFailureModelProfileHash({ ...profile, think: true }, contract),
  );

  const driver = createRepeatedFailureProfileDriver(profile, hash);
  assert.equal(driver.driverKind, "ollama-chat");
  assert.equal(driver.tokenizer.identity, "qwen3-nfkc-v1");
  assert.throws(
    () => computeRepeatedFailureModelProfileHash(
      { ...profile, endpoint: "http://127.0.0.1:11434/v1" },
      contract,
    ),
    /requires a native Ollama endpoint/,
  );
});

interface ParsedEpisodeRow {
  rowKey: string;
  isolation: Record<string, string>;
  identity: {
    variantId: string;
    arm: string;
    modelProfileHash: string;
  };
  finalState: string;
  status: string;
  invalidReason?: string;
  taskPassed?: boolean;
  warningCount: number;
  falseWarningCount: number;
  evidence: {
    startRepoHash: string;
    historyHash: string;
    traceArtifactPath: string;
  };
  tryCount: number;
  tokens: RepeatedFailureTokenUsage;
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
}


function findRequiredRow(
  rows: readonly ParsedEpisodeRow[],
  predicate: (row: ParsedEpisodeRow) => boolean,
): ParsedEpisodeRow {
  const row = rows.find(predicate);
  assert.ok(row);
  return row;
}

function requiredEnumValue(properties: unknown, propertyName: string, index = 0): unknown {
  assertRecord(properties, "tool schema properties");
  const property = properties[propertyName];
  assertRecord(property, `${propertyName} schema`);
  const values = property.enum;
  assert.ok(Array.isArray(values), `${propertyName} schema must define enum values`);
  const value = values.at(index);
  assert.notEqual(value, undefined, `${propertyName} schema must define enum value ${index}`);
  return value;
}

function parseEpisodeRow(line: string): ParsedEpisodeRow {
  const value = parseRepeatedFailureEpisodeRow(JSON.parse(line));
  assert.ok(value.isolation, "episode isolation must be present");
  assert.ok(value.evidence, "episode evidence must be present");
  return {
    rowKey: value.rowKey,
    isolation: Object.fromEntries(Object.entries(value.isolation)),
    identity: {
      variantId: value.identity.variantId,
      arm: value.identity.arm,
      modelProfileHash: value.identity.modelProfileHash,
    },
    finalState: value.finalState,
    status: value.status,
    ...(value.invalidReason ? { invalidReason: value.invalidReason } : {}),
    ...(value.taskPassed !== undefined ? { taskPassed: value.taskPassed } : {}),
    warningCount: value.warningCount ?? 0,
    falseWarningCount: value.falseWarningCount ?? 0,
    evidence: {
      startRepoHash: value.evidence.startRepoHash,
      historyHash: value.evidence.historyHash,
      traceArtifactPath: value.evidence.traceArtifactPath,
    },
    tryCount: value.tryCount,
    tokens: { ...value.tokens },
  };
}

class DeterministicDriver implements RepeatedFailureEpisodeDriver {
  readonly driverKind = "deterministic-fake" as const;
  readonly callsByRow = new Map<string, number>();
  readonly developerInstructions = "Use the frozen synthetic task contract.";
  readonly tokenizer = Object.freeze({
    identity: "synthetic-nfkc-whitespace",
    implementation: "nfkc-whitespace-v1" as const,
  });

  constructor(
    readonly modelProfileId = "fake-profile",
    readonly modelProfileHash = PROFILE_HASH,
    private readonly hostFaultsBeforeSuccess = 0,
    private readonly forceTimidityCut = false,
  ) {}

  async runEpisode(request: RepeatedFailureEpisodeInput): Promise<ControlledResponsesEpisodeResult> {
    const rowKey = rowIdentityKey(request);
    const callNumber = (this.callsByRow.get(rowKey) ?? 0) + 1;
    this.callsByRow.set(rowKey, callNumber);
    if (callNumber <= this.hostFaultsBeforeSuccess) {
      return invalidHostFault(callNumber);
    }

    if (request.identity.variantId.endsWith(":no-trap")) {
      const evidence = await request.toolHost.captureFinalEvidence({ signal: new AbortController().signal });
      if (this.forceTimidityCut && request.identity.arm === "PRE_ACTION_FAILURE") {
        return completedResult(
          request,
          { ...evidence, checkResult: "INDETERMINATE" },
          [],
          [],
          "NONE",
        );
      }
      return completedResult(request, evidence, [], [], "NONE");
    }

    const badAction = strategyAction(request, false, `bad-${request.identity.arm}`);
    const gate = await request.evaluator.evaluate(badAction, { signal: new AbortController().signal });
    if (gate.status === "MATCH_WARN") {
      const goodAction = strategyAction(request, true, `good-${request.identity.arm}`);
      const executed = await request.toolHost.execute(goodAction, { signal: new AbortController().signal });
      assert.equal(executed.status, "completed", JSON.stringify(executed.output));
      const evidence = await request.toolHost.captureFinalEvidence({ signal: new AbortController().signal });
      return completedResult(
        request,
        evidence,
        [gate],
        [toolEvent(goodAction)],
        "CHANGED",
        fingerprint(badAction),
        fingerprint(goodAction),
      );
    }
    const executed = await request.toolHost.execute(badAction, { signal: new AbortController().signal });
    assert.equal(executed.status, "completed", JSON.stringify(executed.output));
    const evidence = await request.toolHost.captureFinalEvidence({ signal: new AbortController().signal });
    return completedResult(request, evidence, [gate], [toolEvent(badAction)], "EXECUTED");
  }
}

class CapExceededDriver extends DeterministicDriver {
  override async runEpisode(request: RepeatedFailureEpisodeInput): Promise<ControlledResponsesEpisodeResult> {
    if (!request.identity.variantId.endsWith(":no-trap") && request.identity.arm === "NO_MEMORY") {
      return {
        status: "INVALID",
        invalidReason: "CAP_EXCEEDED",
        disposition: "NONE",
        outputTextHash: sha256("cap-exceeded"),
        outputTextBytes: 12,
        gateEvents: [],
        responses: [{
          turn: 1,
          responseId: "response-cap",
          status: "completed",
          model: "fake-model",
          outputItemTypes: ["message"],
          usage: {
            input: 10,
            output: 2,
            total: 12,
            cachedInput: 4,
            cacheWriteInput: 3,
            reasoningOutput: 1,
          },
        }],
        tools: [],
        usage: {
          input: 10,
          output: 2,
          total: 12,
          cachedInput: 4,
          cacheWriteInput: 3,
          reasoningOutput: 1,
        },
        faults: [{
          code: "CAP_EXCEEDED",
          stage: "caps",
          messageHash: sha256("TURN_CAP"),
        }],
        finalRepoEvidence: await request.toolHost.captureFinalEvidence({
          signal: new AbortController().signal,
        }),
      };
    }
    return super.runEpisode(request);
  }
}
class DurationCapDriver extends DeterministicDriver {
  override async runEpisode(): Promise<ControlledResponsesEpisodeResult> {
    return {
      status: "INVALID",
      invalidReason: "CAP_EXCEEDED",
      disposition: "NONE",
      outputTextHash: sha256("duration-cap"),
      outputTextBytes: 12,
      gateEvents: [],
      responses: [],
      tools: [],
      usage: {
        input: 0,
        output: 0,
        total: 0,
        cachedInput: 0,
        cacheWriteInput: 0,
        reasoningOutput: 0,
      },
      faults: [{
        code: "DURATION_CAP",
        stage: "caps",
        messageHash: sha256("DURATION_CAP"),
      }],
    };
  }
}


class GateWaitExpiredDriver extends DeterministicDriver {
  override async runEpisode(request: RepeatedFailureEpisodeInput): Promise<ControlledResponsesEpisodeResult> {
    if (!request.identity.variantId.endsWith(":no-trap") && request.identity.arm === "PRE_ACTION_FAILURE") {
      const evidence = await request.toolHost.captureFinalEvidence({
        signal: new AbortController().signal,
      });
      return completedResult(
        request,
        evidence,
        [{
          status: "ERROR_FAIL_OPEN",
          fingerprintHash: sha256("gate-wait"),
          faultCode: "GATE_WAIT_EXPIRED",
        }],
        [],
        "NONE",
      );
    }
    return super.runEpisode(request);
  }
}

function strategyAction(
  request: RepeatedFailureEpisodeInput,
  good: boolean,
  callId: string,
): RepeatedFailureProposedAction {
  const tool = request.toolHost.tools.find((entry) => entry.name === "apply_strategy");
  assert.ok(tool);
  const properties = tool.inputSchema.properties;
  return {
    callId,
    tool: "apply_strategy",
    arguments: {
      identityVersion: requiredEnumValue(properties, "identityVersion"),
      strategyId: requiredEnumValue(properties, "strategyId", good ? 1 : 0),
      actionType: requiredEnumValue(properties, "actionType"),
      targetSymbol: requiredEnumValue(properties, "targetSymbol"),
      filePath: requiredEnumValue(properties, "filePath"),
      contextHash: requiredEnumValue(properties, "contextHash"),
    },
  };
}

function completedResult(
  request: RepeatedFailureEpisodeInput,
  finalRepoEvidence: NonNullable<ControlledResponsesEpisodeResult["finalRepoEvidence"]>,
  gateEvents: ControlledResponsesEpisodeResult["gateEvents"],
  tools: ControlledResponsesEpisodeResult["tools"],
  disposition: ControlledResponsesEpisodeResult["disposition"],
  originalFingerprint?: string,
  replacementFingerprint?: string,
): ControlledResponsesEpisodeResult {
  return {
    status: "COMPLETED",
    disposition,
    outputTextHash: sha256("fake-complete"),
    outputTextBytes: 13,
    ...(originalFingerprint ? { originalFingerprint } : {}),
    ...(replacementFingerprint ? { replacementFingerprint } : {}),
    ...(gateEvents.at(-1) ? { gate: gateEvents.at(-1) } : {}),
    gateEvents,
    responses: [{
      turn: 1,
      responseId: `response-${request.identity.arm}`,
      status: "completed",
      model: "fake-model",
      outputItemTypes: tools.length > 0 ? ["function_call"] : ["message"],
      usage: {
        input: 10,
        output: 2,
        total: 12,
        cachedInput: 4,
        cacheWriteInput: 3,
        reasoningOutput: 1,
      },
    }],
    tools,
    usage: {
      input: 10,
      output: 2,
      total: 12,
      cachedInput: 4,
      cacheWriteInput: 3,
      reasoningOutput: 1,
    },
    faults: [],
    finalRepoEvidence,
  };
}

function invalidHostFault(attempt: number): ControlledResponsesEpisodeResult {
  return {
    status: "INVALID",
    invalidReason: "FAULT",
    disposition: "NONE",
    outputTextHash: sha256(""),
    outputTextBytes: 0,
    gateEvents: [],
    responses: [],
    tools: [],
    usage: {
      input: 1,
      output: 0,
      total: 1,
      cachedInput: 0,
      cacheWriteInput: 0,
      reasoningOutput: 0,
    },
    faults: [{
      code: "HTTP_503",
      stage: "transport",
      messageHash: sha256(`fault-${attempt}`),
    }],
  };
}

function toolEvent(action: RepeatedFailureProposedAction) {
  return {
    callId: action.callId,
    tool: action.tool,
    fingerprint: fingerprint(action),
    status: "completed" as const,
    outputHash: sha256("completed"),
  };
}

function fingerprint(action: RepeatedFailureProposedAction): string {
  return sha256(JSON.stringify({ tool: action.tool, arguments: action.arguments }));
}

function rowIdentityKey(request: RepeatedFailureEpisodeInput): string {
  return JSON.stringify(request.identity);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function runFake(
  outputDir: string,
  drivers: readonly RepeatedFailureEpisodeDriver[],
  resume = false,
) {
  return runRepeatedFailureSuite({
    outputDir,
    drivers,
    seeds: [7],
    mode: "quick",
    taskIds: [TASK_ID],
    variantIds: [VARIANT_ID],
    resume,
    statisticsSeed: 9,
    statisticsDraws: 10_000,
    clock: FIXED_CLOCK,
    now: FIXED_NOW,
  });
}

async function rowsFrom(outputDir: string): Promise<ParsedEpisodeRow[]> {
  return (await readFile(path.join(outputDir, "episodes.jsonl"), "utf8"))
    .trimEnd()
    .split("\n")
    .map(parseEpisodeRow);
}

async function treeHash(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string, relativeRoot: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
      hash.update(relative).update("\0");
      if (entry.isDirectory()) {
        hash.update("directory\0");
        await visit(path.join(directory, entry.name), relative);
      } else {
        hash.update("file\0").update(await readFile(path.join(directory, entry.name))).update("\0");
      }
    }
  };
  await visit(root, "");
  return hash.digest("hex");
}

test("deterministic fake runs preserve row order, hashes, isolation, arms, and no-trap audit", async () => {
  const first = await mkdtemp(path.join(tmpdir(), "h6-suite-first-"));
  const second = await mkdtemp(path.join(tmpdir(), "h6-suite-second-"));
  try {
    const firstRun = await runFake(first, [new DeterministicDriver()]);
    await runFake(second, [new DeterministicDriver()]);
    assert.equal(
      await readFile(path.join(first, "episodes.jsonl"), "utf8"),
      await readFile(path.join(second, "episodes.jsonl"), "utf8"),
    );
    assert.equal(
      await readFile(path.join(first, "statistics.json"), "utf8"),
      await readFile(path.join(second, "statistics.json"), "utf8"),
    );
    const rows = await rowsFrom(first);
    assert.equal(rows.length, 7);
    const expectedUsage = {
      input: 10,
      output: 2,
      total: 12,
      cachedInput: 4,
      cacheWriteInput: 3,
      reasoningOutput: 1,
    };
    for (const row of rows) assert.deepEqual(row.tokens, expectedUsage);
    assert.deepEqual(firstRun.result.results.tasks[0]?.details?.usage, expectedUsage);
    assert.deepEqual(firstRun.result.config.benchmarkOptions?.tokenUsage, {
      input: 70,
      output: 14,
      total: 84,
      cachedInput: 28,
      cacheWriteInput: 21,
      reasoningOutput: 7,
    });
    assert.deepEqual(firstRun.result.cost, {
      totalTokens: 84,
      inputTokens: 70,
      outputTokens: 14,
      estimatedCostUsd: 0,
      totalLatencyMs: 0,
      meanQueryLatencyMs: 0,
      judgeModelCalls: 0,
    });
    const trace: unknown = JSON.parse(
      await readFile(path.join(first, rows[0].evidence.traceArtifactPath), "utf8"),
    );
    assertRecord(trace, "trace");
    assertRecord(trace.result, "trace result");
    assert.deepEqual(trace.result.usage, expectedUsage);
    assert.deepEqual(rows.map((row) => row.rowKey), [...rows.map((row) => row.rowKey)].sort());
    assert.equal(new Set(rows.flatMap((row) => Object.values(row.isolation))).size, rows.length * 7);
    const primary = rows.filter((row) => !row.identity.variantId.endsWith(":no-trap"));
    assert.deepEqual(new Set(primary.map((row) => row.identity.arm)), new Set([
      "NO_MEMORY",
      "TURN_START_FAILURE",
      "TURN_START_SUCCESS",
      "PRE_ACTION_FAILURE",
      "BOTH",
    ]));
    const noMemory = findRequiredRow(primary, (row) => row.identity.arm === "NO_MEMORY");
    const preActionFailure = findRequiredRow(
      primary,
      (row) => row.identity.arm === "PRE_ACTION_FAILURE",
    );
    const both = findRequiredRow(primary, (row) => row.identity.arm === "BOTH");
    const turnStartFailure = findRequiredRow(
      primary,
      (row) => row.identity.arm === "TURN_START_FAILURE",
    );
    assert.equal(noMemory.finalState, "TRAPPED");
    assert.equal(preActionFailure.finalState, "FIXED");
    assert.equal(both.warningCount, 1);
    assert.equal(turnStartFailure.warningCount, 0);
    const noTrapNoMemory = findRequiredRow(
      rows,
      (row) => row.identity.variantId.endsWith(":no-trap") && row.identity.arm === "NO_MEMORY",
    );
    assert.equal(noTrapNoMemory.finalState, "NO_TRAP");
    const noTrapPreAction = findRequiredRow(
      rows,
      (row) => row.identity.variantId.endsWith(":no-trap") && row.identity.arm === "PRE_ACTION_FAILURE",
    );
    assert.equal(noTrapPreAction.status, "VALID");
    assert.equal(noTrapPreAction.finalState, "NO_TRAP");
    assert.equal(noTrapPreAction.warningCount, 0);
    assert.equal(noTrapPreAction.falseWarningCount, 0);
    assert.equal(new Set(primary.map((row) => row.evidence.startRepoHash)).size, 1);
    assert.equal(new Set(primary.map((row) => row.evidence.historyHash)).size, 1);
  } finally {
    await Promise.all([rm(first, { recursive: true, force: true }), rm(second, { recursive: true, force: true })]);
  }
});

test("model profile hash participates in every row key even when profile ids collide", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h6-suite-profiles-"));
  try {
    await runFake(outputDir, [
      new DeterministicDriver("same-id", "2".repeat(64)),
      new DeterministicDriver("same-id", "3".repeat(64)),
    ]);
    const rows = await rowsFrom(outputDir);

    assert.equal(rows.length, 14);
    assert.equal(new Set(rows.map((row) => row.rowKey)).size, 14);
    assert.deepEqual(new Set(rows.map((row) => row.identity.modelProfileHash)), new Set(["2".repeat(64), "3".repeat(64)]));
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("timidity-only cuts remain visible without invalidating complete primary groups", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h6-suite-timidity-cut-"));
  try {
    const run = await runFake(outputDir, [
      new DeterministicDriver("timidity-cut-profile", "8".repeat(64), 0, true),
    ]);
    const analysis = JSON.parse(await readFile(run.statisticsPath, "utf8"));
    assert.ok(analysis.cuts.some((cut: { hypothesis: string }) => cut.hypothesis === "TIMIDITY"));
    assert.ok(analysis.cuts.every(
      (cut: { hypothesis: string }) => cut.hypothesis !== "TIMING" && cut.hypothesis !== "CONTENT",
    ));
    assert.equal(analysis.timidity.taskCount, 0);
    assert.equal(analysis.timidity.equivalent, null);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("only host faults retry while a terminal task result is never rerun", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h6-suite-retries-"));
  try {
    const driver = new DeterministicDriver("retry-profile", "4".repeat(64), 2);
    await runFake(outputDir, [driver]);
    const rows = await rowsFrom(outputDir);
    assert.ok(rows.every((row) => row.tryCount === 3));
    assert.ok([...driver.callsByRow.values()].every((count) => count === 3));
    for (const row of rows) {
      assert.deepEqual(row.tokens, {
        input: 12,
        output: 2,
        total: 14,
        cachedInput: 4,
        cacheWriteInput: 3,
        reasoningOutput: 1,
      });
    }
    const terminalDriver = new DeterministicDriver("terminal-profile", "5".repeat(64));
    const terminalDir = await mkdtemp(path.join(tmpdir(), "h6-suite-terminal-"));
    try {
      await runFake(terminalDir, [terminalDriver]);
      assert.ok([...terminalDriver.callsByRow.values()].every((count) => count === 1));
    } finally {
      await rm(terminalDir, { recursive: true, force: true });
    }
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("third host fault remains auditable before terminal retry exhaustion", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h6-suite-exhausted-"));
  try {
    await runFake(outputDir, [
      new DeterministicDriver("exhausted-profile", "6".repeat(64), 3),
    ]);
    const checkpointNames = await readdir(path.join(outputDir, "checkpoints"));
    assert.ok(checkpointNames.length > 0);
    for (const name of checkpointNames) {
      const checkpoint: unknown = JSON.parse(
        await readFile(path.join(outputDir, "checkpoints", name), "utf8"),
      );
      assertRecord(checkpoint, "exhausted checkpoint");
      assert.ok(Array.isArray(checkpoint.tries));
      assert.equal(checkpoint.tries.length, 3);
      for (const [index, entry] of checkpoint.tries.entries()) {
        assertRecord(entry, "checkpoint try");
        assert.equal(entry.attempt, index + 1);
        assertRecord(entry.outcome, "checkpoint outcome");
        assert.equal(entry.outcome.kind, "HOST_API_FAULT");
      }
      assertRecord(checkpoint.terminal, "checkpoint terminal");
      assert.equal(checkpoint.terminal.invalidReason, "HOST_RETRIES_EXHAUSTED");
      assertRecord(checkpoint.terminal.evidence, "exhausted terminal evidence");
      assertRecord(checkpoint.terminal.isolation, "exhausted terminal isolation");
    }
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("a zero-retry audit terminalizes the first host fault with evidence", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h6-suite-zero-retries-"));
  try {
    await runRepeatedFailureSuite({
      outputDir,
      drivers: [new DeterministicDriver("zero-retry-profile", "7".repeat(64), 1)],
      seeds: [7],
      mode: "quick",
      taskIds: [TASK_ID],
      variantIds: [VARIANT_ID],
      maxHostRetries: 0,
      statisticsSeed: 9,
      statisticsDraws: 10_000,
      clock: FIXED_CLOCK,
      now: FIXED_NOW,
    });
    const rows = await rowsFrom(outputDir);
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.equal(row.tryCount, 1);
      assert.equal(row.status, "INVALID");
      assert.equal(row.invalidReason, "HOST_RETRIES_EXHAUSTED");
      assert.ok(row.evidence);
      assert.ok(row.isolation);
    }
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("cap exhaustion with complete evidence records a failed task result", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h6-suite-cap-result-"));
  try {
    await runFake(outputDir, [new CapExceededDriver()]);
    const rows = await rowsFrom(outputDir);
    const capped = rows.find(
      (row) => row.identity.variantId === VARIANT_ID && row.identity.arm === "NO_MEMORY",
    );
    assert.ok(capped);
    assert.equal(capped.status, "VALID");
    assert.equal(capped.invalidReason, undefined);
    assert.equal(capped.taskPassed, false);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
test("duration expiry is a single terminal cap result rather than a host retry", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h6-suite-duration-cap-"));
  try {
    await runFake(outputDir, [new DurationCapDriver()]);
    const rows = await rowsFrom(outputDir);
    assert.ok(rows.every((row) => row.tryCount === 1));
    assert.ok(rows.every((row) => row.status === "VALID"));
    assert.ok(rows.every((row) => row.taskPassed === false));
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});


test("an expired gate wait invalidates the row as WAIT_RULE_FAULT", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h6-suite-gate-wait-"));
  try {
    await runFake(outputDir, [new GateWaitExpiredDriver()]);
    const rows = await rowsFrom(outputDir);
    const expired = rows.find(
      (row) => row.identity.variantId === VARIANT_ID && row.identity.arm === "PRE_ACTION_FAILURE",
    );
    assert.ok(expired);
    assert.equal(expired.status, "INVALID");
    assert.equal(expired.invalidReason, "WAIT_RULE_FAULT");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("resume preserves two stored host faults and executes only the third try", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h6-suite-resume-"));
  try {
    await runFake(outputDir, [new DeterministicDriver()]);
    const rows = await rowsFrom(outputDir);
    const row = rows[0];
    const checkpointPath = path.join(outputDir, "checkpoints", `${row.rowKey}.json`);
    const checkpoint: unknown = JSON.parse(await readFile(checkpointPath, "utf8"));
    assertRecord(checkpoint, "row checkpoint");
    const storedHostFault = (attempt: 1 | 2) => ({
      attempt,
      durationMs: attempt,
      tokens: {
        input: 1,
        output: 0,
        total: 1,
        cachedInput: 0,
        cacheWriteInput: 0,
        reasoningOutput: 0,
      },
      outcome: {
        kind: "HOST_API_FAULT",
        code: "HTTP_503",
        messageHash: String(attempt + 5).repeat(64),
      },
    });
    checkpoint.tries = [storedHostFault(1), storedHostFault(2)];
    const incompleteCheckpoint = Object.fromEntries(
      Object.entries(checkpoint).filter(([key]) => key !== "terminal"),
    );
    await writeFile(checkpointPath, `${JSON.stringify(incompleteCheckpoint, null, 2)}\n`);

    const preLoopArtifacts = new Set([
      "run.json",
      "expected-design.json",
      "decision-rule.json",
      "deviations.jsonl",
    ]);
    const rootEntries = await readdir(outputDir, { withFileTypes: true });
    await Promise.all(rootEntries
      .filter((entry) => entry.isFile() && !preLoopArtifacts.has(entry.name))
      .map((entry) => rm(path.join(outputDir, entry.name), { force: true })));

    const resumeDriver = new DeterministicDriver();
    const resumed = await runFake(outputDir, [resumeDriver], true);
    assert.equal(resumed.resumed, 6);
    assert.equal([...resumeDriver.callsByRow.values()].reduce((sum, value) => sum + value, 0), 1);

    const resumedCheckpoint: unknown = JSON.parse(await readFile(checkpointPath, "utf8"));
    assertRecord(resumedCheckpoint, "resumed checkpoint");
    assert.ok(Array.isArray(resumedCheckpoint.tries));
    assert.deepEqual(
      resumedCheckpoint.tries.map((entry) => {
        assertRecord(entry, "resumed try");
        return entry.attempt;
      }),
      [1, 2, 3],
    );
    const thirdTry = resumedCheckpoint.tries[2];
    assertRecord(thirdTry, "third try");
    assertRecord(thirdTry.outcome, "third outcome");
    assert.equal(thirdTry.outcome.kind, "TASK_RESULT");

    const completedRows = await rowsFrom(outputDir);
    const completed = completedRows.find((entry) => entry.rowKey === row.rowKey);
    assert.deepEqual(completed?.tokens, {
      input: 12,
      output: 2,
      total: 14,
      cachedInput: 4,
      cacheWriteInput: 3,
      reasoningOutput: 1,
    });
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("resume completes an interrupted finalization after episodes are written", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h6-suite-finalize-resume-"));
  try {
    await runFake(outputDir, [new DeterministicDriver()]);
    await rm(path.join(outputDir, "MANIFEST.json"));
    const resumeDriver = new DeterministicDriver();
    const resumed = await runFake(outputDir, [resumeDriver], true);
    assert.equal(resumed.completed, 0);
    assert.equal(resumed.resumed, 7);
    assert.equal(resumeDriver.callsByRow.size, 0);
    assert.ok((await readFile(path.join(outputDir, "MANIFEST.json"), "utf8")).length > 0);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
test("resume fails closed on malformed checkpoints without rerunning the row", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h6-suite-malformed-resume-"));
  try {
    await runFake(outputDir, [new DeterministicDriver()]);
    await rm(path.join(outputDir, "MANIFEST.json"));
    const row = (await rowsFrom(outputDir))[0];
    const checkpointPath = path.join(outputDir, "checkpoints", `${row.rowKey}.json`);
    await writeFile(checkpointPath, "{");
    const resumeDriver = new DeterministicDriver();
    await assert.rejects(
      () => runFake(outputDir, [resumeDriver], true),
      /Malformed repeated-failure checkpoint/,
    );
    assert.equal(await readFile(checkpointPath, "utf8"), "{");
    assert.equal(resumeDriver.callsByRow.size, 0);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("resume fails closed without mutating a terminal row whose trace is missing", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h6-suite-missing-trace-"));
  try {
    await runFake(outputDir, [new DeterministicDriver()]);
    const row = (await rowsFrom(outputDir))[0];
    const checkpointPath = path.join(outputDir, "checkpoints", `${row.rowKey}.json`);
    const checkpointBefore = await readFile(checkpointPath, "utf8");
    await rm(path.join(outputDir, row.evidence.traceArtifactPath));

    const resumeDriver = new DeterministicDriver();
    await assert.rejects(
      () => runFake(outputDir, [resumeDriver], true),
      /ENOENT|terminal trace artifact is missing or drifted/,
    );
    assert.equal(await readFile(checkpointPath, "utf8"), checkpointBefore);
    assert.equal(resumeDriver.callsByRow.size, 0);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("episode row schema rejects incomplete and wrong-version terminal rows", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h6-suite-row-schema-"));
  try {
    await runFake(outputDir, [new DeterministicDriver()]);
    const [line] = (await readFile(path.join(outputDir, "episodes.jsonl"), "utf8"))
      .trim()
      .split("\n");
    const complete = JSON.parse(line ?? "") as Record<string, unknown>;
    const incomplete = Object.fromEntries(
      Object.entries(complete).filter(([key]) => key !== "evidence"),
    );
    assert.throws(
      () => parseRepeatedFailureEpisodeRow(incomplete),
      /Invalid input|evidence/,
    );
    assert.throws(
      () => parseRepeatedFailureEpisodeRow({ ...complete, schemaVersion: 2 }),
      /Invalid input|schemaVersion/,
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("statistics replay is model-free, fail-closed, and byte-stable", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h6-suite-replay-"));
  try {
    await runFake(outputDir, [new DeterministicDriver()]);
    const before = await readFile(path.join(outputDir, "statistics.json"), "utf8");
    assert.deepEqual(await replayRepeatedFailureStatistics({ runDir: outputDir }), {
      exitCode: 0,
      output: JSON.stringify({ statisticsPath: "statistics.json", rows: 7, modelCalls: 0 }),
    });
    assert.equal(await readFile(path.join(outputDir, "statistics.json"), "utf8"), before);
    await writeFile(path.join(outputDir, "episodes.jsonl"), "{corrupt}\n");
    const failed = await replayRepeatedFailureStatistics({ runDir: outputDir });
    assert.equal(failed.exitCode, 1);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("primary cuts publish a complete NOT_ESTIMABLE artifact set", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h6-suite-primary-cut-"));
  try {
    const run = await runFake(outputDir, [
      new GateWaitExpiredDriver("primary-cut-profile", "9".repeat(64)),
    ]);
    const statistics = JSON.parse(await readFile(run.statisticsPath, "utf8")) as Record<string, unknown>;
    assertRecord(statistics.decisions, "statistics decisions");
    assert.equal(statistics.decisions.timing, "NOT_ESTIMABLE");
    assert.equal(statistics.studyDecision, "NOT_ESTIMABLE");
    assert.ok(Array.isArray(statistics.cuts) && statistics.cuts.length > 0);
    const power = JSON.parse(await readFile(run.powerPath, "utf8")) as Record<string, unknown>;
    assert.equal(power.status, "NOT_ESTIMABLE");
    const audit = JSON.parse(await readFile(run.auditPath, "utf8")) as Record<string, unknown>;
    assert.equal(audit.decision, "NOT_ESTIMABLE");
    const result = JSON.parse(await readFile(run.resultPath, "utf8")) as Record<string, unknown>;
    assertRecord(result.config, "benchmark result config");
    assertRecord(result.config.benchmarkOptions, "benchmark options");
    assert.equal(result.config.benchmarkOptions.studyDecision, "NOT_ESTIMABLE");
    for (const artifactPath of [
      run.statisticsPath,
      run.powerPath,
      run.auditPath,
      run.resultPath,
      run.manifestPath,
      run.decisionRulePath,
      run.runMetadataPath,
      run.expectedDesignPath,
      run.factPairAuditPath,
    ]) {
      JSON.parse(await readFile(artifactPath, "utf8"));
    }
    assert.ok((await readFile(run.episodesPath, "utf8")).trim().length > 0);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("run metadata freezes revisions, caps, locks, sandbox, retry, order, and analysis provenance", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h6-suite-metadata-"));
  try {
    const run = await runFake(outputDir, [new DeterministicDriver()]);
    const metadata = JSON.parse(await readFile(run.runMetadataPath, "utf8")) as Record<string, unknown>;
    assert.equal(metadata.analysisVersion, "h6-task-bootstrap-shuffle-holm-v1");
    assert.equal(typeof metadata.harnessVersion, "string");
    assert.equal(typeof metadata.harnessSourceHash, "string");
    assert.equal(typeof metadata.decisionRuleHash, "string");
    assert.equal(typeof metadata.provenanceHash, "string");
    assert.ok(Array.isArray(metadata.taskRevisions) && metadata.taskRevisions.length === 1);
    assert.deepEqual(metadata.caps, {
      maxTurns: 12,
      maxToolCalls: 8,
      maxTotalTokens: 16_384,
      maxDurationMs: 120_000,
      requestTimeoutMs: 60_000,
      maxToolOutputChars: 16_384,
    });
    assertRecord(metadata.toolLocks, "tool locks");
    assertRecord(metadata.sandboxFlags, "sandbox flags");
    assert.deepEqual(metadata.retryRule, {
      hostApiFaultRetriesAfterFirstTry: 2,
      rerunTaskResults: false,
      retainAllTries: true,
    });
    assert.ok(Array.isArray(metadata.runOrder) && metadata.runOrder.length === 7);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("main phase rejects reduced frozen inputs and cannot start without verified pilot power", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "h6-suite-main-gates-"));
  const drivers = [
    new DeterministicDriver("main-profile-a", "a".repeat(64)),
    new DeterministicDriver("main-profile-b", "b".repeat(64)),
  ];
  const base = {
    drivers,
    seeds: [1, 2, 3, 4, 5],
    mode: "full" as const,
    phase: "main" as const,
    taskIds: MAIN_TASK_IDS,
    statisticsSeed: 81,
    statisticsDraws: 10_000,
    clock: FIXED_CLOCK,
    now: FIXED_NOW,
  };
  try {
    await assert.rejects(
      runRepeatedFailureSuite({ ...base, outputDir: path.join(root, "reduced-seeds"), seeds: [1, 2, 3, 4] }),
      /exact frozen seeds/,
    );
    const firstDriver = drivers[0];
    assert.ok(firstDriver);
    await assert.rejects(
      runRepeatedFailureSuite({
        ...base,
        outputDir: path.join(root, "reduced-profiles"),
        drivers: [firstDriver],
      }),
      /exactly two immutable model profiles/,
    );
    await assert.rejects(
      runRepeatedFailureSuite({ ...base, outputDir: path.join(root, "reduced-draws"), statisticsDraws: 9_999 }),
      /exactly 10000/,
    );
    await assert.rejects(
      runRepeatedFailureSuite({
        ...base,
        outputDir: path.join(root, "reduced-caps"),
        caps: { maxTurns: 11 },
      }),
      /frozen response caps/,
    );
    await assert.rejects(
      runRepeatedFailureSuite({ ...base, outputDir: path.join(root, "missing-pilot") }),
      /verified pilot run/,
    );
    assert.equal(drivers.flatMap((driver) => [...driver.callsByRow.values()]).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resume and replay reject tampered episode, decision, manifest, and provenance bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "h6-suite-drift-gates-"));
  try {
    const episodeDir = path.join(root, "episode");
    await mkdir(episodeDir);
    await runFake(episodeDir, [new DeterministicDriver()]);
    const runBytes = await readFile(path.join(episodeDir, "run.json"), "utf8");
    const episodeBytes = await readFile(path.join(episodeDir, "episodes.jsonl"), "utf8");
    await writeFile(path.join(episodeDir, "episodes.jsonl"), `${episodeBytes.trimEnd()}\n{"tampered":true}\n`);
    await assert.rejects(
      runFake(episodeDir, [new DeterministicDriver()], true),
      /manifest supplemental artifact hash mismatch/,
    );
    assert.equal(await readFile(path.join(episodeDir, "run.json"), "utf8"), runBytes);

    const decisionDir = path.join(root, "decision");
    await mkdir(decisionDir);
    await runFake(decisionDir, [new DeterministicDriver()]);
    const statisticsBefore = await readFile(path.join(decisionDir, "statistics.json"), "utf8");
    await writeFile(path.join(decisionDir, "decision-rule.json"), "{}\n");
    assert.equal((await replayRepeatedFailureStatistics({ runDir: decisionDir })).exitCode, 1);
    assert.equal(await readFile(path.join(decisionDir, "statistics.json"), "utf8"), statisticsBefore);

    const manifestDir = path.join(root, "manifest");
    await mkdir(manifestDir);
    await runFake(manifestDir, [new DeterministicDriver()]);
    const manifestPath = path.join(manifestDir, "MANIFEST.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.artifactHash = "0".repeat(64);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.equal((await replayRepeatedFailureStatistics({ runDir: manifestDir })).exitCode, 1);

    const provenanceDir = path.join(root, "provenance");
    await mkdir(provenanceDir);
    await runFake(provenanceDir, [new DeterministicDriver()]);
    const provenancePath = path.join(provenanceDir, "run.json");
    const provenance = JSON.parse(await readFile(provenancePath, "utf8")) as Record<string, unknown>;
    provenance.provenanceHash = "f".repeat(64);
    await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
    await assert.rejects(
      runFake(provenanceDir, [new DeterministicDriver()], true),
      /manifest supplemental artifact hash mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("benchmark output refuses live-like Remnic memory roots before mutation", async () => {
  const memoryRoot = await mkdtemp(path.join(tmpdir(), "h6-live-memory-guard-"));
  try {
    await mkdir(path.join(memoryRoot, "state"));
    await writeFile(path.join(memoryRoot, "profile.md"), "# Synthetic live-like profile\n");
    await writeFile(path.join(memoryRoot, "sentinel.txt"), "must remain byte-identical\n");
    const before = await treeHash(memoryRoot);
    await assert.rejects(
      runFake(path.join(memoryRoot, "benchmark-output"), [new DeterministicDriver()]),
      { message: "refusing benchmark output inside a Remnic memory store" },
    );
    assert.equal(await treeHash(memoryRoot), before);
    assert.deepEqual(
      (await readdir(memoryRoot)).sort(),
      ["profile.md", "sentinel.txt", "state"],
    );
  } finally {
    await rm(memoryRoot, { recursive: true, force: true });
  }
});
