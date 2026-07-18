import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  RelayMissionEventSchema,
  reduceRelayMission,
  relayMissionReceiptDigest,
  type RelayMissionEvent,
} from "@remnic/core";
import type { CodexCreditReceipt, CodexCreditReceiptScope } from "@remnic/bench";
import { z } from "zod";

import {
  RELAY_ACCOUNT_CREDIT_CAP_UNITS,
  RELAY_CREDIT_BUDGET_UNITS,
  RELAY_CREDIT_RESERVE_UNITS,
  RELAY_MAX_LIVE_CALLS,
  RELAY_MISSION_ID,
  RELAY_MODEL,
  RELAY_NAMESPACE,
  RELAY_OPERATOR_PRINCIPAL,
  RELAY_PLANNED_SPEND_CEILING_UNITS,
  RELAY_REASONING_EFFORT,
  RelayBuilderOutputSchema,
  RelayCodexCallSummarySchema,
  RelayPreflightReceiptSchema,
  RelayResolverOutputSchema,
  RelayRoleSchema,
  RelayScoutOutputSchema,
  RelayTestResultSchema,
  type RelayPreflightReceipt,
  type RelayRole,
} from "./contracts.js";
import { assertTreeContainsNoSymlinks, digestFixtureTree, pathExists } from "./isolation.js";
import type { RelayMissionRunResult, SanitizedRelayCall } from "./mission-runner.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const finiteNonnegative = z.number().finite().nonnegative();
const usageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningOutputTokens: z.number().int().nonnegative(),
  })
  .strict();
const scopeSchema = usageSchema.extend({
  calls: z.number().int().nonnegative(),
  budgetUnits: finiteNonnegative,
  accountBalanceResolutionCount: z.number().int().nonnegative(),
  conservativeResolutionChargeUnits: finiteNonnegative,
  models: z.array(
    usageSchema
      .extend({ model: z.literal(RELAY_MODEL), calls: z.number().int().positive(), budgetUnits: finiteNonnegative })
      .strict(),
  ),
});

export const RelaySanitizedCreditReceiptSchema = z
  .object({
    schemaVersion: z.literal(2),
    ledgerSha256: sha256Schema,
    budgetUnits: z.number().int().positive().max(RELAY_CREDIT_BUDGET_UNITS),
    reserveUnits: z.literal(RELAY_CREDIT_RESERVE_UNITS),
    plannedSpendCeilingUnits: z.number().int().positive().max(RELAY_PLANNED_SPEND_CEILING_UNITS),
    totalSpentUnits: finiteNonnegative,
    remainingBudgetUnits: finiteNonnegative,
    blocked: z.literal(false),
    run: scopeSchema.extend({ id: z.string().min(1).max(128) }).strict(),
  })
  .strict()
  .refine((value) => value.budgetUnits - value.reserveUnits === value.plannedSpendCeilingUnits, {
    message: "credit receipt must preserve the fixed reserve",
    path: ["plannedSpendCeilingUnits"],
  });
export type RelaySanitizedCreditReceipt = z.infer<typeof RelaySanitizedCreditReceiptSchema>;

const RelayRecordingMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.string().datetime({ offset: true }),
    missionId: z.literal(RELAY_MISSION_ID),
    namespace: z.literal(RELAY_NAMESPACE),
    runMode: z.literal("live"),
    model: z.literal(RELAY_MODEL),
    reasoningEffort: z.literal(RELAY_REASONING_EFFORT),
    accountCreditCapUnits: z.literal(RELAY_ACCOUNT_CREDIT_CAP_UNITS),
    quarantinedUncertainUnits: z.number().int().nonnegative(),
    quarantinedLedgerSha256: sha256Schema.nullable(),
    effectiveBudgetUnits: z.number().int().positive().max(RELAY_CREDIT_BUDGET_UNITS),
    fixtureManifestSha256: sha256Schema,
    missionReceiptSha256: sha256Schema,
    callOrder: z.tuple([
      z.literal("scout"),
      z.literal("stale-builder"),
      z.literal("resolver"),
      z.literal("cold-builder"),
    ]),
    threadIds: z.array(z.string().uuid()).length(RELAY_MAX_LIVE_CALLS),
    testTransition: z.tuple([z.literal("failed"), z.literal("passed")]),
    creditUnitsSpentByRun: finiteNonnegative,
    evidence: z
      .object({
        syntheticFixturesOnly: z.literal(true),
        productionDataRead: z.literal(false),
        transcriptsShared: z.literal(false),
        promptsRecorded: z.literal(false),
        rawJsonlRecorded: z.literal(false),
        integrityManifest: z.literal(true),
      })
      .strict(),
  })
  .strict();
export type RelayRecordingMetadata = z.infer<typeof RelayRecordingMetadataSchema>;

const RelayRecordingManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    files: z
      .array(
        z.object({ path: z.string().min(1), bytes: z.number().int().nonnegative(), sha256: sha256Schema }).strict(),
      )
      .min(1),
    rootSha256: sha256Schema,
  })
  .strict();

const RelayMissionReceiptArtifactSchema = z
  .object({
    missionReceiptSha256: sha256Schema,
    complete: z.literal(true),
    missingEvidence: z.tuple([]),
    coldStartVerified: z.literal(true),
    passingOutcomeVerified: z.literal(true),
    activeDecisionIds: z.array(z.string()),
    supersededDecisionIds: z.array(z.string()),
    outcome: z.literal("recovered"),
  })
  .strict();

const RelayCorrectionArtifactSchema = z
  .object({
    planId: z.string().min(1).max(256),
    correctionId: z.literal("correction-token-refresh"),
    outcomeStatus: z.literal("applied"),
    staleMemoryStatus: z.literal("superseded"),
    staleMemoryId: z.string().min(1).max(256),
    replacementMemoryId: z.string().min(1).max(256),
    resolverBridgeRequests: z.literal(1),
  })
  .strict();

const RelayApprovalArtifactSchema = z
  .object({
    approved: z.literal(true),
    operatorPrincipal: z.literal(RELAY_OPERATOR_PRINCIPAL),
    gate: z.literal("--approve-correction APPROVE"),
  })
  .strict();

const RelayMemoryArtifactSchema = z
  .object({
    memoryId: z.string().min(1).max(256),
    decisionId: z.enum(["decision-new-token-every-request", "decision-refresh-after-expiry"]),
    status: z.enum(["superseded", "active"]),
    statement: z.string().min(1).max(2_000),
    synthetic: z.literal(true),
  })
  .strict();

const RelayBudgetAdjustmentArtifactSchema = z
  .object({
    accountCreditCapUnits: z.literal(RELAY_ACCOUNT_CREDIT_CAP_UNITS),
    quarantinedUncertainUnits: z.number().int().nonnegative(),
    quarantinedLedgerSha256: sha256Schema.nullable(),
    effectiveBudgetUnits: z.number().int().positive().max(RELAY_CREDIT_BUDGET_UNITS),
    reserveUnits: z.literal(RELAY_CREDIT_RESERVE_UNITS),
    plannedSpendCeilingUnits: z.number().int().positive().max(RELAY_PLANNED_SPEND_CEILING_UNITS),
    basis: z.literal("worst-case carry-forward for prior uncertain dispatch"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.accountCreditCapUnits - value.quarantinedUncertainUnits !== value.effectiveBudgetUnits) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "effective budget mismatch", path: ["effectiveBudgetUnits"] });
    }
    if (value.effectiveBudgetUnits - value.reserveUnits !== value.plannedSpendCeilingUnits) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "planned spend ceiling mismatch",
        path: ["plannedSpendCeilingUnits"],
      });
    }
    if ((value.quarantinedUncertainUnits === 0) !== (value.quarantinedLedgerSha256 === null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "quarantine evidence mismatch", path: ["quarantinedLedgerSha256"] });
    }
  });

export interface WriteRelayRecordingOptions {
  recordingDir: string;
  repoRoot: string;
  generatedAt: string;
  preflight: RelayPreflightReceipt;
  creditReceipt: CodexCreditReceipt;
  runId: string;
  missionRun: RelayMissionRunResult;
}
export interface VerifiedRelayRecording {
  rootSha256: string;
  metadata: RelayRecordingMetadata;
  events: RelayMissionEvent[];
  preflight: RelayPreflightReceipt;
  creditReceipt: RelaySanitizedCreditReceipt;
  calls: SanitizedRelayCall[];
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(root: string, relative: string, value: unknown): Promise<void> {
  const destination = path.join(root, relative);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o644, flag: "wx" });
}

function sanitizeCreditReceipt(receipt: CodexCreditReceipt, runId: string): RelaySanitizedCreditReceipt {
  if (receipt.blocked || !receipt.run || receipt.run.id !== runId) {
    throw new Error("Relay recording requires an unblocked run-scoped credit receipt");
  }
  if (receipt.run.calls !== RELAY_MAX_LIVE_CALLS) {
    throw new Error("Relay recording requires exactly four accounted Codex calls");
  }
  if (receipt.run.models.length !== 1 || receipt.run.models[0]?.model !== RELAY_MODEL) {
    throw new Error("Relay recording credit receipt must contain only exact gpt-5.6");
  }
  if (receipt.run.budgetUnits > RELAY_PLANNED_SPEND_CEILING_UNITS) {
    throw new Error("Relay recording run exceeded the planned credit ceiling");
  }
  return RelaySanitizedCreditReceiptSchema.parse({
    schemaVersion: receipt.schemaVersion,
    ledgerSha256: receipt.ledgerSha256,
    budgetUnits: receipt.budgetUnits,
    reserveUnits: receipt.reserveUnits,
    plannedSpendCeilingUnits: receipt.plannedSpendCeilingUnits,
    totalSpentUnits: receipt.totalSpentUnits,
    remainingBudgetUnits: receipt.remainingBudgetUnits,
    blocked: receipt.blocked,
    run: receipt.run,
  });
}

function scanSensitive(value: unknown, repoRoot: string, location = "recording"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanSensitive(item, repoRoot, `${location}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (["stdout", "stderr", "prompt", "mcpToken", "authSourcePath", "codexBinary"].includes(key)) {
        throw new Error(`Relay recording rejects raw or sensitive field ${location}.${key}`);
      }
      scanSensitive(item, repoRoot, `${location}.${key}`);
    }
    return;
  }
  if (typeof value !== "string") return;
  const forbidden = [repoRoot, "/home/", "REMNIC_RELAY_MCP_TOKEN", "OPENAI_API_KEY", ".codex/auth.json", "Bearer "];
  if (forbidden.some((needle) => value.includes(needle))) {
    throw new Error(`Relay recording rejected host path or secret-like material at ${location}`);
  }
  if (/\bsk-[A-Za-z0-9_-]{16,}\b/.test(value)) {
    throw new Error(`Relay recording rejected an API-key-like value at ${location}`);
  }
}

function parseCallArtifact(role: RelayRole, raw: unknown): SanitizedRelayCall {
  const envelope = z.object({ summary: RelayCodexCallSummarySchema, output: z.unknown() }).strict().parse(raw);
  if (envelope.summary.role !== role) throw new Error(`Relay recording call role mismatch for ${role}`);
  const output =
    role === "scout"
      ? RelayScoutOutputSchema.parse(envelope.output)
      : role === "resolver"
        ? RelayResolverOutputSchema.parse(envelope.output)
        : RelayBuilderOutputSchema.parse(envelope.output);
  return { summary: envelope.summary, output };
}

function expectedFiles(): string[] {
  return [
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
}

export async function writeRelayRecording(options: WriteRelayRecordingOptions): Promise<string> {
  const target = path.resolve(options.recordingDir);
  if (await pathExists(target)) throw new Error("Relay recording destination already exists; refusing to overwrite evidence");
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o755 });
  const parentInfo = await lstat(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw new Error("Relay recording parent must be a real directory");
  }
  const temporary = path.join(parent, `.${path.basename(target)}.tmp-${randomBytes(6).toString("hex")}`);
  await mkdir(temporary, { mode: 0o700 });
  try {
    const creditReceipt = sanitizeCreditReceipt(options.creditReceipt, options.runId);
    const metadata = RelayRecordingMetadataSchema.parse({
      schemaVersion: 1,
      generatedAt: options.generatedAt,
      missionId: RELAY_MISSION_ID,
      namespace: RELAY_NAMESPACE,
      runMode: "live",
      model: RELAY_MODEL,
      reasoningEffort: RELAY_REASONING_EFFORT,
      accountCreditCapUnits: options.preflight.accountCreditCapUnits,
      quarantinedUncertainUnits: options.preflight.quarantinedUncertainUnits,
      quarantinedLedgerSha256: options.preflight.quarantinedLedgerSha256,
      effectiveBudgetUnits: options.preflight.budgetUnits,
      fixtureManifestSha256: options.missionRun.fixtureManifestSha256,
      missionReceiptSha256: options.missionRun.missionReceiptSha256,
      callOrder: options.missionRun.calls.map((call) => call.summary.role),
      threadIds: options.missionRun.calls.map((call) => call.summary.threadId),
      testTransition: options.missionRun.tests.map((item) => item.status),
      creditUnitsSpentByRun: creditReceipt.run.budgetUnits,
      evidence: {
        syntheticFixturesOnly: true,
        productionDataRead: false,
        transcriptsShared: false,
        promptsRecorded: false,
        rawJsonlRecorded: false,
        integrityManifest: true,
      },
    });
    const missionReceipt = RelayMissionReceiptArtifactSchema.parse({
      missionReceiptSha256: options.missionRun.missionReceiptSha256,
      complete: options.missionRun.mission.receipt.complete,
      missingEvidence: options.missionRun.mission.receipt.missingEvidence,
      coldStartVerified: options.missionRun.mission.receipt.coldStartVerified,
      passingOutcomeVerified: options.missionRun.mission.receipt.passingOutcomeVerified,
      activeDecisionIds: options.missionRun.mission.receipt.activeDecisionIds,
      supersededDecisionIds: options.missionRun.mission.receipt.supersededDecisionIds,
      outcome: options.missionRun.mission.outcome?.result,
    });
    const correction = RelayCorrectionArtifactSchema.parse({
      ...options.missionRun.correction,
      correctionId: "correction-token-refresh",
      staleMemoryId: options.missionRun.staleMemoryId,
      replacementMemoryId: options.missionRun.replacementMemoryId,
    });
    const approval = RelayApprovalArtifactSchema.parse({
      ...options.missionRun.approval,
      gate: "--approve-correction APPROVE",
    });
    const staleMemory = RelayMemoryArtifactSchema.parse({
      memoryId: options.missionRun.staleMemoryId,
      decisionId: "decision-new-token-every-request",
      status: "superseded",
      statement: "Mint a new checkout token for every request and every retry.",
      synthetic: true,
    });
    const replacementMemory = RelayMemoryArtifactSchema.parse({
      memoryId: options.missionRun.replacementMemoryId,
      decisionId: "decision-refresh-after-expiry",
      status: "active",
      statement:
        "Reuse the checkout-session token while it is valid and mint exactly one replacement only after expiry.",
      synthetic: true,
    });
    const budgetAdjustment = RelayBudgetAdjustmentArtifactSchema.parse({
      accountCreditCapUnits: options.preflight.accountCreditCapUnits,
      quarantinedUncertainUnits: options.preflight.quarantinedUncertainUnits,
      quarantinedLedgerSha256: options.preflight.quarantinedLedgerSha256,
      effectiveBudgetUnits: options.preflight.budgetUnits,
      reserveUnits: options.preflight.reserveUnits,
      plannedSpendCeilingUnits: options.preflight.plannedSpendCeilingUnits,
      basis: "worst-case carry-forward for prior uncertain dispatch",
    });
    const artifacts: Array<[string, unknown]> = [
      ["recording.json", metadata],
      ["preflight.json", RelayPreflightReceiptSchema.parse(options.preflight)],
      ["credit-receipt.json", creditReceipt],
      ["budget-adjustment.json", budgetAdjustment],
      ["approval.json", approval],
      ["correction.json", correction],
      ["mission-receipt.json", missionReceipt],
      ["events.json", options.missionRun.mission.events],
      ["tests.json", options.missionRun.tests],
      ["memories/stale.json", staleMemory],
      ["memories/replacement.json", replacementMemory],
      ...options.missionRun.calls.map((call) => [`calls/${call.summary.role}.json`, call] as [string, unknown]),
    ];
    for (const [relative, value] of artifacts) {
      scanSensitive(value, options.repoRoot, relative);
      await writeJson(temporary, relative, value);
    }
    const files = await digestFixtureTree(temporary);
    if (JSON.stringify(files.map((item) => item.path)) !== JSON.stringify(expectedFiles())) {
      throw new Error("Relay recording artifact set is incomplete or unexpected");
    }
    const manifest = RelayRecordingManifestSchema.parse({
      schemaVersion: 1,
      files,
      rootSha256: sha256(JSON.stringify(files)),
    });
    await writeJson(temporary, "manifest.json", manifest);
    await assertTreeContainsNoSymlinks(temporary);
    await rename(temporary, target);
    return manifest.rootSha256;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function readJson(root: string, relative: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(root, relative), "utf8"));
}

export async function verifyRelayRecording(recordingDir: string, repoRoot: string): Promise<VerifiedRelayRecording> {
  const root = path.resolve(recordingDir);
  await assertTreeContainsNoSymlinks(root);
  const manifest = RelayRecordingManifestSchema.parse(await readJson(root, "manifest.json"));
  const actualFiles = await digestFixtureTree(root, ["manifest.json"]);
  const actualManifest = RelayRecordingManifestSchema.parse({
    schemaVersion: 1,
    files: actualFiles,
    rootSha256: sha256(JSON.stringify(actualFiles)),
  });
  if (JSON.stringify(manifest) !== JSON.stringify(actualManifest)) {
    throw new Error("Relay recording integrity manifest does not match the evidence files");
  }
  if (JSON.stringify(manifest.files.map((item) => item.path)) !== JSON.stringify(expectedFiles())) {
    throw new Error("Relay recording contains an unexpected evidence file set");
  }

  const metadata = RelayRecordingMetadataSchema.parse(await readJson(root, "recording.json"));
  const preflight = RelayPreflightReceiptSchema.parse(await readJson(root, "preflight.json"));
  const creditReceipt = RelaySanitizedCreditReceiptSchema.parse(await readJson(root, "credit-receipt.json"));
  const budgetAdjustment = RelayBudgetAdjustmentArtifactSchema.parse(await readJson(root, "budget-adjustment.json"));
  const events = z.array(RelayMissionEventSchema).length(16).parse(await readJson(root, "events.json"));
  const tests = z.tuple([RelayTestResultSchema, RelayTestResultSchema]).parse(await readJson(root, "tests.json"));
  const calls: SanitizedRelayCall[] = [];
  for (const role of RelayRoleSchema.options) {
    calls.push(parseCallArtifact(role, await readJson(root, `calls/${role}.json`)));
  }
  RelayApprovalArtifactSchema.parse(await readJson(root, "approval.json"));
  RelayCorrectionArtifactSchema.parse(await readJson(root, "correction.json"));
  RelayMemoryArtifactSchema.parse(await readJson(root, "memories/stale.json"));
  RelayMemoryArtifactSchema.parse(await readJson(root, "memories/replacement.json"));
  const missionReceipt = RelayMissionReceiptArtifactSchema.parse(await readJson(root, "mission-receipt.json"));

  if (JSON.stringify(calls.map((call) => call.summary.role)) !== JSON.stringify(metadata.callOrder)) {
    throw new Error("Relay recording call artifacts do not match the declared call order");
  }
  const callThreadIds = calls.map((call) => call.summary.threadId);
  if (JSON.stringify(callThreadIds) !== JSON.stringify(metadata.threadIds)) {
    throw new Error("Relay recording call artifacts do not match the declared thread IDs");
  }
  if (new Set(callThreadIds).size !== RELAY_MAX_LIVE_CALLS) {
    throw new Error("Relay recording does not prove four transcript-free Codex threads");
  }
  const coldCall = calls.find((call) => call.summary.role === "cold-builder");
  if (!coldCall) throw new Error("Relay recording omitted the cold Builder call artifact");
  const expectedColdSessionId = `session-${coldCall.summary.threadId}`;
  const recallEvents = events.filter((event) => event.payload.kind === "recall_observed");
  const propagationEvents = events.filter((event) => event.payload.kind === "propagation_verified");
  if (recallEvents.length !== 1 || propagationEvents.length !== 1) {
    throw new Error("Relay recording must contain exactly one cold recall and propagation event");
  }
  const recallEvent = recallEvents[0];
  const propagationEvent = propagationEvents[0];
  if (!recallEvent || !propagationEvent) {
    throw new Error("Relay recording omitted its cold recall or propagation event");
  }
  const recallPayload = recallEvent.payload;
  const propagationPayload = propagationEvent.payload;
  if (
    recallPayload.kind !== "recall_observed" ||
    propagationPayload.kind !== "propagation_verified" ||
    recallPayload.agentId !== "agent-cold-builder" ||
    propagationPayload.agentId !== "agent-cold-builder" ||
    recallPayload.sessionId !== expectedColdSessionId ||
    propagationPayload.sessionId !== expectedColdSessionId
  ) {
    throw new Error("Relay recording cold evidence is not bound to the cold Builder thread");
  }
  if (JSON.stringify(tests.map((item) => item.status)) !== JSON.stringify(metadata.testTransition)) {
    throw new Error("Relay recording test evidence does not prove fail-before/pass-after");
  }
  const mission = reduceRelayMission({
    missionId: RELAY_MISSION_ID,
    namespace: RELAY_NAMESPACE,
    events,
    fileExists: true,
  });
  const receiptDigest = relayMissionReceiptDigest(mission);
  if (!mission.receipt.complete || receiptDigest !== metadata.missionReceiptSha256) {
    throw new Error("Relay recording events do not reduce to the sealed mission receipt");
  }
  if (missionReceipt.missionReceiptSha256 !== receiptDigest) {
    throw new Error("Relay recording receipt artifact does not match its events");
  }
  if (creditReceipt.run.calls !== RELAY_MAX_LIVE_CALLS || creditReceipt.run.budgetUnits !== metadata.creditUnitsSpentByRun) {
    throw new Error("Relay recording credit evidence does not match its metadata");
  }
  if (
    creditReceipt.budgetUnits !== metadata.effectiveBudgetUnits ||
    creditReceipt.budgetUnits !== budgetAdjustment.effectiveBudgetUnits ||
    metadata.accountCreditCapUnits - metadata.quarantinedUncertainUnits !== metadata.effectiveBudgetUnits ||
    metadata.quarantinedLedgerSha256 !== budgetAdjustment.quarantinedLedgerSha256
  ) {
    throw new Error("Relay recording budget adjustment does not match the effective credit ledger");
  }
  if (preflight.fixtureManifestSha256 !== metadata.fixtureManifestSha256) {
    throw new Error("Relay recording preflight and mission used different synthetic fixtures");
  }
  scanSensitive(
    { metadata, preflight, creditReceipt, budgetAdjustment, events, tests, calls, missionReceipt },
    path.resolve(repoRoot),
  );
  return { rootSha256: manifest.rootSha256, metadata, events, preflight, creditReceipt, calls };
}
