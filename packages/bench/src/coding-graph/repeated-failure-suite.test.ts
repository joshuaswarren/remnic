import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { compareCodePoints } from "../codepoint-order.js";
import {
  computeRepeatedFailureModelProfileHash,
  createRepeatedFailureProfileDriver,
  replayRepeatedFailureStatistics,
  runRepeatedFailureSuite,
} from "./repeated-failure-suite.ts";
import { parseRunMetadata } from "./repeated-failure-suite-execution.ts";
import { bindProfileRequestTimeout } from "./repeated-failure-suite-output.ts";
import { parseRepeatedFailureEpisodeRow } from "./repeated-failure-store.ts";
import type { ControlledResponsesEpisodeResult } from "./repeated-failure-responses-driver.ts";
import {
  H6_DECISION_RULE,
  H6_FROZEN_INVENTORY_HASH,
  H6_SUPPORT_ARTIFACT_PATHS,
  resolveCommittedH6FixtureDirectory,
} from "./repo-gen/index.ts";
import { DecisionRuleSchema, PROMPT_CONTRACT } from "./repeated-failure-suite-shared.ts";
import type { ModelProfileExecutionContract } from "./repeated-failure-suite-output.ts";
import {
  resolvePackagedPreregistrationRoot,
  verifyPreregistrationBinding,
  registeredModelDigestsMatch,
} from "./repeated-failure-suite-runner.ts";
import { REPEATED_FAILURE_ARMS } from "./repeated-failure-types.ts";
import type {
  RepeatedFailureEpisodeDriver,
  RepeatedFailureEpisodeInput,
  RepeatedFailureProposedAction,
  RepeatedFailureRunMetadata,
  RepeatedFailureTokenUsage,
} from "./repeated-failure-types.ts";

const TASK_ID = "h6-task-01";
const VARIANT_ID = "h6-task-01-v1";
const PROFILE_HASH = "1".repeat(64);
const FIXED_NOW = () => new Date("2026-01-02T00:00:00.000Z");

test("registered replay accepts the frozen one-profile digest set", () => {
  assert.equal(registeredModelDigestsMatch(["a".repeat(64)], 1), true);
  assert.equal(registeredModelDigestsMatch(["a".repeat(64)], 2), false);
  assert.equal(registeredModelDigestsMatch(["a".repeat(64), "a".repeat(64)], 2), false);
  assert.equal(registeredModelDigestsMatch(["a".repeat(64), "b".repeat(64)], 2), true);
});
const FIXED_CLOCK = () => 100;
const MAIN_TASK_IDS = Object.freeze([
  "h6-task-03", "h6-task-04", "h6-task-05", "h6-task-08", "h6-task-09", "h6-task-10",
  "h6-task-13", "h6-task-14", "h6-task-15", "h6-task-18", "h6-task-19", "h6-task-20",
  "h6-task-23", "h6-task-24", "h6-task-25", "h6-task-28", "h6-task-29", "h6-task-30",
]);

async function writePreregistrationAt(root: string, bytes: string | Buffer): Promise<void> {
  const destination = path.join(root, H6_DECISION_RULE.preregistration.path);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
}
function validRunMetadata(): RepeatedFailureRunMetadata {
  const hash = "1".repeat(64);
  const revision = "2".repeat(40);
  const identity = {
    suiteVersion: "h6-failure-gate-v1-test",
    taskId: TASK_ID,
    variantId: VARIANT_ID,
    modelProfileId: "profile",
    modelProfileHash: hash,
    seed: 1,
    arm: "NO_MEMORY" as const,
  };
  return {
    schemaVersion: 1,
    runId: "run",
    suiteVersion: identity.suiteVersion,
    datasetInventoryHash: H6_FROZEN_INVENTORY_HASH,
    resumeContractHash: hash,
    expectedDesignHash: hash,
    decisionRuleHash: hash,
    preregistrationPath: H6_DECISION_RULE.preregistration.path,
    preregistrationHash: H6_DECISION_RULE.preregistration.sha256,
    analysisVersion: "analysis",
    harnessVersion: "harness",
    harnessSourceHash: hash,
    provenanceHash: hash,
    gitSha: "",
    gitDirty: false,
    gitDirtyEntryCount: 0,
    phase: "unspecified",
    mode: "quick",
    arms: REPEATED_FAILURE_ARMS,
    modelProfileIds: [identity.modelProfileId],
    modelProfileHashes: [identity.modelProfileHash],
    modelDigests: [hash],
    modelDriverKinds: ["deterministic-fake"],
    modelTokenizerIdentities: ["test-tokenizer"],
    modelTokenizerImplementations: ["nfkc-whitespace-v1"],
    trapAuditReceipts: [],
    seeds: [identity.seed],
    splitTaskIds: [identity.taskId],
    taskRevisions: [{
      taskId: identity.taskId,
      variantId: identity.variantId,
      cleanRevisionSha: revision,
      trapRevisionSha: revision,
      rightRevisionSha: revision,
      noTrapRevisionSha: revision,
    }],
    caps: {
      maxTurns: 1,
      maxToolCalls: 1,
      maxTotalTokens: 1,
      maxDurationMs: 1,
      requestTimeoutMs: 1,
      maxToolOutputChars: 1,
    },
    toolLocks: {
      allowedTools: ["apply_strategy"],
      taskToolSchemaHashes: [{
        taskId: identity.taskId,
        variantId: identity.variantId,
        sha256: hash,
      }],
    },
    sandboxFlags: {
      networkDisabled: true,
      isolatedRepoPerArm: true,
      isolatedMemoryPerArm: true,
      isolatedSessionPerArm: true,
      rejectSymlinks: true,
    },
    retryRule: {
      hostApiFaultRetriesAfterFirstTry: 5,
      rerunTaskResults: false,
      retainAllTries: true,
    },
    runOrder: [{ rowKey: "row", analysis: "PRIMARY", identity }],
    expectedRowCount: 1,
    statisticsSeed: 1,
    statisticsDraws: 1,
  };
}



test("decision rule schema seals preregistration and requires the frozen inventory", () => {
  const { datasetInventoryHash: _inventoryHash, ...populationWithoutInventory } =
    H6_DECISION_RULE.analysisPopulation;
  assert.throws(
    () => DecisionRuleSchema.parse({
      ...H6_DECISION_RULE,
      analysisPopulation: populationWithoutInventory,
    }),
    /datasetInventoryHash/,
  );
  assert.throws(
    () => DecisionRuleSchema.parse({
      ...H6_DECISION_RULE,
      preregistration: {
        ...H6_DECISION_RULE.preregistration,
        sha256: "0".repeat(64),
      },
    }),
    /preregistration|sha256/,
  );
  const parsed = DecisionRuleSchema.parse(H6_DECISION_RULE);
  assert.equal(parsed.version, 12);
  assert.equal(parsed.analysisPopulation.datasetInventoryHash, H6_FROZEN_INVENTORY_HASH);
  assert.equal((H6_SUPPORT_ARTIFACT_PATHS as readonly string[]).includes("decision-rule.json"), false);
  const {
    requireRepeatedFailureBenefitIntervalLowerStrictlyAbove: _timingIntervalFloor,
    ...timingWithoutIntervalFloor
  } = H6_DECISION_RULE.hypotheses["H6-timing"];
  assert.throws(
    () => DecisionRuleSchema.parse({
      ...H6_DECISION_RULE,
      hypotheses: {
        ...H6_DECISION_RULE.hypotheses,
        "H6-timing": timingWithoutIntervalFloor,
      },
    }),
    /requireRepeatedFailureBenefitIntervalLowerStrictlyAbove/,
  );
});
test("run metadata schema rejects missing and stale preregistration bindings", () => {
  const metadata = validRunMetadata();
  assert.equal(
    parseRunMetadata(metadata).preregistrationPath,
    H6_DECISION_RULE.preregistration.path,
  );
  const missingPath = { ...metadata } as Partial<RepeatedFailureRunMetadata>;
  delete missingPath.preregistrationPath;
  assert.throws(() => parseRunMetadata(missingPath), /preregistrationPath/);
  assert.throws(
    () => parseRunMetadata({ ...metadata, preregistrationPath: "docs/research/old.md" }),
    /preregistrationPath|Invalid literal/,
  );
  assert.throws(
    () => parseRunMetadata({ ...metadata, preregistrationHash: "0".repeat(64) }),
    /preregistrationHash|Invalid literal/,
  );
  assert.throws(
    () => parseRunMetadata({ ...metadata, datasetInventoryHash: "0".repeat(64) }),
    /datasetInventoryHash|Invalid literal/,
  );
  const missingDigests = { ...metadata } as Partial<RepeatedFailureRunMetadata>;
  delete missingDigests.modelDigests;
  assert.throws(() => parseRunMetadata(missingDigests), /modelDigests/);
  assert.throws(
    () => parseRunMetadata({ ...metadata, modelDigests: [] }),
    /modelDigests|same length/,
  );
  assert.throws(
    () => parseRunMetadata({
      ...metadata,
      trapAuditReceipts: [{
        path: "trap-audit.json",
        artifactHash: "1".repeat(64),
        modelProfileId: "profile",
        modelProfileHash: "1".repeat(64),
      }],
    }),
    /modelDigest/,
  );
  assert.throws(
    () => parseRunMetadata({ ...metadata, phase: "main" }),
    /pilotEvidence|verified pilot evidence/,
  );
});

test("preregistration verification rejects a missing file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "h6-prereg-missing-"));
  try {
    await assert.rejects(
      () => verifyPreregistrationBinding(root, H6_DECISION_RULE.preregistration),
      /ENOENT|preregistration file is missing/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preregistration verification rejects altered raw bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "h6-prereg-altered-"));
  try {
    await writePreregistrationAt(root, "altered preregistration bytes\n");
    await assert.rejects(
      () => verifyPreregistrationBinding(root, H6_DECISION_RULE.preregistration),
      /preregistration hash mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preregistration verification accepts the sealed raw bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "h6-prereg-valid-"));
  try {
    const source = path.resolve(H6_DECISION_RULE.preregistration.path);
    await writePreregistrationAt(root, await readFile(source));
    assert.equal(
      await verifyPreregistrationBinding(root, H6_DECISION_RULE.preregistration),
      H6_DECISION_RULE.preregistration.sha256,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packaged preregistration resource exactly matches the sealed source artifact", async () => {
  const fixtureDir = await resolveCommittedH6FixtureDirectory();
  const packageRoot = path.join(fixtureDir, "..", "..");
  const sourceResourcePath = path.join(packageRoot, "preregistration", "h6-failure-gate.md");
  const bundledResourcePath = path.join(packageRoot, "dist");
  const bundledModuleUrl = pathToFileURL(
    path.join(packageRoot, "dist", "index.js"),
  ).href;
  const [sourceBytes, packagedBytes] = await Promise.all([
    readFile(path.resolve(H6_DECISION_RULE.preregistration.path), "utf8"),
    readFile(sourceResourcePath, "utf8"),
  ]);
  assert.equal(resolvePackagedPreregistrationRoot(), path.dirname(sourceResourcePath));
  assert.equal(resolvePackagedPreregistrationRoot(bundledModuleUrl), bundledResourcePath);
  assert.equal(packagedBytes, sourceBytes);
  assert.equal(
    createHash("sha256").update(packagedBytes).digest("hex"),
    H6_DECISION_RULE.preregistration.sha256,
  );
  assert.equal(
    await verifyPreregistrationBinding(
      resolvePackagedPreregistrationRoot(bundledModuleUrl),
      H6_DECISION_RULE.preregistration,
      path.basename(sourceResourcePath),
    ),
    H6_DECISION_RULE.preregistration.sha256,
  );
});


test("immutable profile hash binds prompts, tools, tokenizer, decoding, and native Ollama endpoint", () => {
  const profile = {
    schemaVersion: 2,
    id: "local-8b",
    provider: "ollama-chat",
    model: "qwen3:8b",
    endpoint: "http://127.0.0.1:11434/api/chat",
    modelDigest: "a".repeat(64),
    instructions: { system: "system contract", developer: "developer contract" },
    tokenizer: { identity: "qwen3-nfkc-v1", implementation: "nfkc-whitespace-v1" },
    contextWindowTokens: 131_072,
    requestTimeoutMs: 300_000,
    temperature: 0,
    maxOutputTokens: 8_192,
    think: false,
    seedCapability: { kind: "options_parameter", requestField: "seed" },
  } as const;
  const contract = {
    schemaVersion: 1,
    datasetInventoryHash: H6_FROZEN_INVENTORY_HASH,
    prompt: PROMPT_CONTRACT,
    tools: [{
      taskId: TASK_ID,
      variantId: VARIANT_ID,
      definitions: [{
        type: "function",
        name: "apply_strategy",
        description: "Apply the selected repair strategy.",
        strict: true,
        parameters: { type: "object" },
      }],
    }],
    tokenizerUse: "content-pair-counts-and-timing-rendered-counts",
    decodingAndContext: {
      caps: {
        maxTurns: 8,
        maxToolCalls: 6,
        maxTotalTokens: 65_536,
        maxDurationMs: 600_000,
        requestTimeoutMs: 180_000,
      },
      maxToolOutputChars: 16_384,
      fingerprintVersion: 1,
      preActionWarningVersion: 1,
    },
  } as const satisfies ModelProfileExecutionContract;
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
      decodingAndContext: {
        ...contract.decodingAndContext,
        caps: { ...contract.decodingAndContext.caps, maxTurns: 9 },
      },
    }),
  );
  assert.notEqual(
    hash,
    computeRepeatedFailureModelProfileHash({ ...profile, think: true }, contract),
  );
  assert.notEqual(
    hash,
    computeRepeatedFailureModelProfileHash({ ...profile, requestTimeoutMs: 120_000 }, contract),
  );
  assert.notEqual(
    hash,
    computeRepeatedFailureModelProfileHash({ ...profile, modelDigest: "b".repeat(64) }, contract),
  );
  const { modelDigest: _modelDigest, ...profileWithoutDigest } = profile;
  assert.throws(
    () => computeRepeatedFailureModelProfileHash(profileWithoutDigest, contract),
    /modelDigest/,
  );

  const driver = createRepeatedFailureProfileDriver(profile, contract);
  assert.equal(driver.driverKind, "ollama-chat");
  assert.equal(driver.modelDigest, profile.modelDigest);
  assert.equal(driver.tokenizer.identity, "qwen3-nfkc-v1");
  assert.throws(
    () => computeRepeatedFailureModelProfileHash(
      { ...profile, endpoint: "http://127.0.0.1:11434/v1" },
      contract,
    ),
    /requires a native Ollama endpoint/,
  );
});

test("caller request timeout cap overrides the profile timeout", async () => {
  let observedTimeoutMs = 0;
  let preflightCalls = 0;
  const source: RepeatedFailureEpisodeDriver = {
    driverKind: "deterministic-fake",
    modelProfileId: "profile",
    modelProfileHash: PROFILE_HASH,
    modelDigest: PROFILE_HASH,
    developerInstructions: "instructions",
    tokenizer: { identity: "tokenizer", implementation: "nfkc-whitespace-v1" },
    preflight: async () => {
      preflightCalls += 1;
    },
    runEpisode: async (request) => {
      observedTimeoutMs = request.caps.requestTimeoutMs;
      return invalidHostFault(1);
    },
  };
  const driver = bindProfileRequestTimeout(source, 300_000);
  await driver.preflight?.();
  await driver.runEpisode({
    identity: {
      suiteVersion: "suite",
      taskId: TASK_ID,
      variantId: VARIANT_ID,
      modelProfileId: "profile",
      modelProfileHash: PROFILE_HASH,
      seed: 1,
      arm: "NO_MEMORY",
    },
    prompt: "prompt",
    caps: {
      maxTurns: 1,
      maxToolCalls: 1,
      maxTotalTokens: 1,
      maxDurationMs: 1,
      requestTimeoutMs: 60_000,
    },
    toolHost: {
      tools: [],
      execute: async () => ({ status: "failed", output: "unused" }),
      captureFinalEvidence: async () => ({
        repoHash: "repo",
        checkResult: "INDETERMINATE",
        changedFiles: [],
      }),
    },
    evaluator: {
      evaluate: async () => ({ status: "NO_MATCH", fingerprintHash: "unused" }),
    },
  });
  assert.equal(observedTimeoutMs, 60_000);
  assert.equal(preflightCalls, 1);
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
    readonly modelDigest = modelProfileHash,
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
class PreflightTrackingDriver extends DeterministicDriver {
  preflightCalls = 0;

  async preflight(): Promise<void> {
    this.preflightCalls += 1;
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


class GateFailOpenDriver extends DeterministicDriver {
  constructor(
    private readonly faultCode: string,
    modelProfileId?: string,
    modelProfileHash?: string,
  ) {
    super(modelProfileId, modelProfileHash);
  }

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
          fingerprintHash: sha256("gate-failure"),
          faultCode: this.faultCode,
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
    entries.sort((left, right) => compareCodePoints(left.name, right.name));
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

test("suite preflights every driver before starting any row", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h6-suite-preflight-"));
  let preflightCalls = 0;
  let rowStarts = 0;
  const driver: RepeatedFailureEpisodeDriver = {
    driverKind: "deterministic-fake",
    modelProfileId: "failed-preflight-profile",
    modelProfileHash: PROFILE_HASH,
    modelDigest: PROFILE_HASH,
    developerInstructions: "instructions",
    tokenizer: { identity: "tokenizer", implementation: "nfkc-whitespace-v1" },
    async preflight() {
      preflightCalls += 1;
      throw new Error("model digest mismatch");
    },
    async runEpisode() {
      rowStarts += 1;
      return invalidHostFault(1);
    },
  };

  try {
    await assert.rejects(() => runFake(outputDir, [driver]), /model digest mismatch/);
    assert.equal(preflightCalls, 1);
    assert.equal(rowStarts, 0);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

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

test("host faults short of exhaustion are auditable and the row recovers", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h6-suite-exhausted-"));
  try {
    // Three faults against the frozen six-attempt budget: the row must record
    // every fault with verifiable trace evidence and then complete normally.
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
      assert.equal(checkpoint.tries.length, 4);
      for (const [index, entry] of checkpoint.tries.entries()) {
        assertRecord(entry, "checkpoint try");
        assert.equal(entry.attempt, index + 1);
        assertRecord(entry.outcome, "checkpoint outcome");
        if (index < 3) {
          assert.equal(entry.outcome.kind, "HOST_API_FAULT");
          assert.equal(typeof entry.outcome.traceArtifactPath, "string");
          assert.match(String(entry.outcome.traceArtifactHash), /^[a-f0-9]{64}$/);
          const traceBytes = await readFile(
            path.join(outputDir, entry.outcome.traceArtifactPath as string),
          );
          assert.equal(
            createHash("sha256").update(traceBytes).digest("hex"),
            entry.outcome.traceArtifactHash,
          );
          const trace = JSON.parse(traceBytes.toString("utf8")) as Record<string, unknown>;
          assertRecord(trace.result, "fault trace result");
          assert.ok(Array.isArray((trace.result as { responses?: unknown }).responses));
          assert.ok(Array.isArray((trace.result as { tools?: unknown }).tools));
          assert.ok(Array.isArray((trace.result as { gateEvents?: unknown }).gateEvents));
          assertRecord(trace.finalRepoEvidence, "fault trace repository evidence");
          continue;
        }
        assert.equal(entry.outcome.kind, "TASK_RESULT");
      }
      // Recovery before the budget runs out must not invalidate the row.
      assertRecord(checkpoint.terminal, "checkpoint terminal");
      assert.notEqual(checkpoint.terminal.invalidReason, "HOST_RETRIES_EXHAUSTED");
    }
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("a zero-retry audit pauses the run and persists the exhausting fault", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h6-suite-zero-retries-"));
  try {
    // Decision rule v10: exhausting the retry budget pauses the suite instead
    // of marking the row invalid, so a transient outage cannot void a run.
    await assert.rejects(
      runRepeatedFailureSuite({
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
      }),
      /Host API fault retries exhausted/,
    );
    // The attempt that stopped the run is committed before the pause so a
    // resumed run replays from the next attempt with a complete history.
    const checkpointNames = await readdir(path.join(outputDir, "checkpoints"));
    assert.ok(checkpointNames.length > 0);
    for (const name of checkpointNames) {
      const checkpoint: unknown = JSON.parse(
        await readFile(path.join(outputDir, "checkpoints", name), "utf8"),
      );
      assertRecord(checkpoint, "paused checkpoint");
      assert.ok(Array.isArray(checkpoint.tries));
      assert.equal(checkpoint.tries.length, 1);
      const [entry] = checkpoint.tries;
      assertRecord(entry, "paused try");
      assertRecord(entry.outcome, "paused outcome");
      assert.equal(entry.outcome.kind, "HOST_API_FAULT");
      assert.match(String(entry.outcome.traceArtifactHash), /^[a-f0-9]{64}$/);
      assert.equal(checkpoint.terminal, undefined);
    }
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("resume receives a fresh host-retry budget after a paused session", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h6-suite-fresh-resume-budget-"));
  const profileId = "fresh-budget-profile";
  const profileHash = "8".repeat(64);
  const options = {
    outputDir,
    seeds: [7],
    mode: "quick" as const,
    taskIds: [TASK_ID],
    variantIds: [VARIANT_ID],
    maxHostRetries: 1 as const,
    statisticsSeed: 9,
    statisticsDraws: 10_000,
    clock: FIXED_CLOCK,
    now: FIXED_NOW,
  };
  try {
    await assert.rejects(
      runRepeatedFailureSuite({
        ...options,
        drivers: [new DeterministicDriver(profileId, profileHash, 2)],
      }),
      /Host API fault retries exhausted/,
    );

    const resumed = await runRepeatedFailureSuite({
      ...options,
      drivers: [new DeterministicDriver(profileId, profileHash, 1)],
      resume: true,
    });
    assert.ok(resumed.completed > 0);

    const checkpointNames = await readdir(path.join(outputDir, "checkpoints"));
    const checkpoints: unknown[] = await Promise.all(checkpointNames.map(async (name) =>
      JSON.parse(await readFile(path.join(outputDir, "checkpoints", name), "utf8")) as unknown
    ));
    const resumedCheckpoint = checkpoints.find(
      (candidate) => typeof candidate === "object"
        && candidate !== null
        && "tries" in candidate
        && Array.isArray(candidate.tries)
        && candidate.tries.length === 4,
    );
    assertRecord(resumedCheckpoint, "resumed checkpoint");
    assert.ok(Array.isArray(resumedCheckpoint.tries));
    assert.deepEqual(
      resumedCheckpoint.tries.map((entry) => {
        assertRecord(entry, "resumed try");
        return entry.attempt;
      }),
      [1, 2, 3, 4],
    );
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
    await runFake(outputDir, [new GateFailOpenDriver("GATE_WAIT_EXPIRED")]);
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

test("any gate fail-open maps to a WAIT_RULE_FAULT invalid row", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h6-suite-gate-failure-"));
  try {
    await runFake(outputDir, [new GateFailOpenDriver("INVALID_EVALUATOR_RESULT")]);
    const rows = await rowsFrom(outputDir);
    const failed = rows.find(
      (row) => row.identity.variantId === VARIANT_ID && row.identity.arm === "PRE_ACTION_FAILURE",
    );
    assert.ok(failed);
    assert.equal(failed.status, "INVALID");
    assert.equal(failed.invalidReason, "WAIT_RULE_FAULT");
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
    const storedTrace = (attempt: 1 | 2) => {
      const bytes = `${JSON.stringify({ schemaVersion: 1, attempt })}\n`;
      return {
        path: `traces/${row.rowKey}/attempt-${attempt}.json`,
        bytes,
        hash: createHash("sha256").update(bytes).digest("hex"),
      };
    };
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
        traceArtifactPath: storedTrace(attempt).path,
        traceArtifactHash: storedTrace(attempt).hash,
      },
    });
    await Promise.all(([1, 2] as const).map(async (attempt) => {
      const trace = storedTrace(attempt);
      const tracePath = path.join(outputDir, trace.path);
      await mkdir(path.dirname(tracePath), { recursive: true });
      await writeFile(tracePath, trace.bytes);
    }));
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
test("resume rejects stale preregistration metadata before driver preflight", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h6-suite-prereg-resume-"));
  try {
    const run = await runFake(outputDir, [new DeterministicDriver()]);
    await rm(path.join(outputDir, "MANIFEST.json"));
    const metadata = JSON.parse(await readFile(run.runMetadataPath, "utf8")) as Record<string, unknown>;
    metadata.preregistrationHash = "0".repeat(64);
    await writeFile(run.runMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

    const resumeDriver = new PreflightTrackingDriver();
    await assert.rejects(
      () => runFake(outputDir, [resumeDriver], true),
      /preregistrationHash|Invalid literal/,
    );
    assert.equal(resumeDriver.preflightCalls, 0);
    assert.equal(resumeDriver.callsByRow.size, 0);
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

test("resume rejects a missing trace from a nonterminal host-fault attempt", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h6-suite-missing-retry-trace-"));
  try {
    const profileId = "retry-resume-profile";
    const profileHash = "9".repeat(64);
    await runFake(outputDir, [new DeterministicDriver(profileId, profileHash, 2)]);
    await rm(path.join(outputDir, "MANIFEST.json"));
    const row = (await rowsFrom(outputDir))[0];
    const checkpointPath = path.join(outputDir, "checkpoints", `${row.rowKey}.json`);
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    assert.ok(Array.isArray(checkpoint.tries));
    const firstTry = checkpoint.tries[0];
    assertRecord(firstTry, "first retry try");
    assertRecord(firstTry.outcome, "first retry outcome");
    assert.equal(firstTry.outcome.kind, "HOST_API_FAULT");
    assert.equal(typeof firstTry.outcome.traceArtifactPath, "string");
    checkpoint.tries = [firstTry];
    delete checkpoint.terminal;
    await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
    await rm(path.join(outputDir, firstTry.outcome.traceArtifactPath as string));

    const resumeDriver = new DeterministicDriver(profileId, profileHash, 2);
    await assert.rejects(
      () => runFake(outputDir, [resumeDriver], true),
      /attempt trace artifact is missing or drifted/,
    );
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

test("manifest verification rejects a changed nonterminal host-fault trace", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h6-suite-retry-trace-manifest-"));
  try {
    await runFake(outputDir, [
      new DeterministicDriver("retry-manifest-profile", "b".repeat(64), 2),
    ]);
    const row = (await rowsFrom(outputDir))[0];
    const checkpoint = JSON.parse(
      await readFile(path.join(outputDir, "checkpoints", `${row.rowKey}.json`), "utf8"),
    );
    assert.ok(Array.isArray(checkpoint.tries));
    const firstTry = checkpoint.tries[0];
    assertRecord(firstTry, "manifest retry try");
    assertRecord(firstTry.outcome, "manifest retry outcome");
    assert.equal(firstTry.outcome.kind, "HOST_API_FAULT");
    assert.equal(typeof firstTry.outcome.traceArtifactPath, "string");
    await writeFile(
      path.join(outputDir, firstTry.outcome.traceArtifactPath as string),
      '{"tampered":true}\n',
    );

    const replay = await replayRepeatedFailureStatistics({ runDir: outputDir });
    assert.equal(replay.exitCode, 1);
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
      new GateFailOpenDriver("GATE_WAIT_EXPIRED", "primary-cut-profile", "9".repeat(64)),
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
    assert.equal(metadata.datasetInventoryHash, H6_FROZEN_INVENTORY_HASH);
    assert.equal(metadata.preregistrationPath, H6_DECISION_RULE.preregistration.path);
    assert.equal(metadata.preregistrationHash, H6_DECISION_RULE.preregistration.sha256);
    const parsed = parseRunMetadata(metadata);
    assert.equal(parsed.preregistrationPath, H6_DECISION_RULE.preregistration.path);
    assert.deepEqual(metadata.modelDigests, [PROFILE_HASH]);
    const missingBinding = { ...metadata };
    delete missingBinding.preregistrationPath;
    assert.throws(() => parseRunMetadata(missingBinding), /preregistrationPath/);
    assert.throws(
      () => parseRunMetadata({ ...metadata, preregistrationHash: "0".repeat(64) }),
      /preregistrationHash|Invalid literal/,
    );
    assert.ok(Array.isArray(metadata.taskRevisions) && metadata.taskRevisions.length === 1);
    assert.deepEqual(metadata.caps, {
      maxTurns: 12,
      maxToolCalls: 8,
      maxTotalTokens: 20_480,
      maxDurationMs: 600_000,
      requestTimeoutMs: 180_000,
      maxToolOutputChars: 16_384,
    });
    assertRecord(metadata.toolLocks, "tool locks");
    assertRecord(metadata.sandboxFlags, "sandbox flags");
    assert.deepEqual(metadata.retryRule, {
      hostApiFaultRetriesAfterFirstTry: 5,
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
    await assert.rejects(
      runRepeatedFailureSuite({
        ...base,
        outputDir: path.join(root, "wrong-profile-count"),
        drivers: [
          new DeterministicDriver("excess-profile-a", "a".repeat(64)),
          new DeterministicDriver("excess-profile-b", "b".repeat(64)),
        ],
      }),
      /exactly 1 immutable model profile/,
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
