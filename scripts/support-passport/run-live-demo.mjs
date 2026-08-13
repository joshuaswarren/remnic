import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  SupportPassportAnswerOutputSchema,
  SupportPassportCardSchema,
  SupportPassportModelAuditRecordSchema,
  SupportPassportPublicGuideSchema,
  expandTildePath,
  resolveEnvVars,
  resolveSupportPassportModelRoutePlan,
} from "@remnic/core";
import { loadConfigFile, startServer } from "@remnic/server";
import { z } from "zod";
import {
  DEMO_ENVIRONMENT_KEYS,
  isolateDemoRemnicConfig,
  isolateEnvironmentVariables,
  modelRequestTimeoutMs,
  readCleanCommitSha,
  runCleanupSteps,
  runWithReservedOutput,
  waitForResult,
} from "./live-demo-runtime.mjs";
import {
  ExpectedPublicCardsFixtureSchema,
  SourceMemoriesFixtureSchema,
  SupportPassportReceiptSchema,
  computeFixtureHash,
  computeResponseHashChain,
  receiptStatusSequence,
  sha256,
} from "./receipt-schema.mjs";
import { validateReceiptConsistency } from "./verify-receipt.mjs";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const RevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
const GrantIdSchema = z.string().uuid();
const MemoryPreviewResponseSchema = z
  .object({
    found: z.literal(true),
    memory: z
      .object({
        id: z.string().min(1),
        content: z.string(),
        revision: RevisionSchema,
      })
      .strict(),
  })
  .strict();
const DraftResponseSchema = z.object({ cards: z.array(SupportPassportCardSchema).min(1).max(8) }).strict();
const CardResponseSchema = z.object({ card: SupportPassportCardSchema }).strict();
const GrantResponseSchema = z
  .object({
    grantId: GrantIdSchema,
    secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    expiresAt: z.string().datetime({ offset: true }),
    version: z.number().int().positive(),
  })
  .strict();
const RevokeResponseSchema = z
  .object({
    grantId: GrantIdSchema,
    revokedAt: z.string().datetime({ offset: true }),
    version: z.number().int().positive(),
  })
  .strict();
const GRANT_MODEL_MARGIN_MS = 5 * 60_000;
const MemoryStoreResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    operation: z.literal("memory_store"),
    namespace: z.string().min(1),
    dryRun: z.literal(false),
    accepted: z.literal(true),
    queued: z.literal(false),
    status: z.enum(["stored", "duplicate"]),
    memoryId: z.string().min(1),
    duplicateOf: z.string().optional(),
    idempotencyKey: z.string().optional(),
    idempotencyReplay: z.boolean().optional(),
  })
  .strict();

class DemoFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "DemoFailure";
  }
}

function usage() {
  return `Usage:
  npm run demo:support-passport:live -- --output <directory> [--config <file>]

Options:
  --output <directory>  Write receipt.json here. Existing receipts are never replaced.
  --config <file>       Reuse a standalone Remnic local, direct, or compatible model configuration.
  --help                Show this help.`;
}

function parseArgs(argv) {
  const options = { help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--output" || arg === "--config") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new DemoFailure(`${arg} requires a value.`);
      if (arg === "--output") options.output = value;
      else options.config = value;
      index += 1;
      continue;
    }
    throw new DemoFailure(`Unknown option: ${arg}`);
  }
  if (!options.help && !options.output) throw new DemoFailure("--output requires a directory.");
  return options;
}

async function readJson(filePath, schema) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new DemoFailure("A support passport fixture is not valid JSON.");
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new DemoFailure("A support passport fixture does not match its strict schema.");
  return result.data;
}

async function findAvailablePort() {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new DemoFailure("Could not reserve a loopback port.");
    return address.port;
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

function resolveInputConfig(options) {
  const rawPath = options.config ?? process.env.REMNIC_CONFIG_PATH ?? process.env.ENGRAM_CONFIG_PATH;
  if (!rawPath) return { remnic: {}, server: {} };
  try {
    return loadConfigFile(path.resolve(expandTildePath(rawPath)));
  } catch {
    throw new DemoFailure("The selected Remnic config could not be loaded.");
  }
}

async function requestJson(url, init, expectedStatus, label, timeoutMs = 45_000) {
  let response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new DemoFailure(`${label} ended before an HTTP response.`);
  }
  const rawBody = await response.text();
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new DemoFailure(`${label} returned non-JSON data.`);
  }
  if (response.status !== expectedStatus) {
    const code = body && typeof body === "object" && typeof body.code === "string" ? ` (${body.code})` : "";
    throw new DemoFailure(`${label} returned HTTP ${response.status}${code}.`);
  }
  return {
    body,
    rawBody,
    response,
    receiptEntry: { status: response.status, bodySha256: sha256(rawBody) },
  };
}

async function waitForReady(baseUrl, authToken) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/engram/v1/health`, {
        headers: { authorization: `Bearer ${authToken}` },
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new DemoFailure("The fresh Remnic server did not become ready.");
}

function ownerHeaders(authToken) {
  return { authorization: `Bearer ${authToken}`, "content-type": "application/json" };
}

function helperHeaders(secret, includeContentType = false) {
  return {
    authorization: `SupportPassport ${secret}`,
    ...(includeContentType ? { "content-type": "application/json" } : {}),
  };
}

function parseBody(schema, request, label) {
  const result = schema.safeParse(request.body);
  if (!result.success) throw new DemoFailure(`${label} returned an invalid response shape.`);
  return result.data;
}

function assertPrivateHelperResponse(response, label) {
  if (response.headers.get("cache-control") !== "private, no-store") {
    throw new DemoFailure(`${label} did not set Cache-Control: private, no-store.`);
  }
  if (response.headers.get("vary")?.toLowerCase() !== "authorization") {
    throw new DemoFailure(`${label} did not set Vary: Authorization.`);
  }
}

function transportFor(audit, config) {
  if (audit.route === "local") return "local-compatible";
  if (audit.route === "gateway") return "gateway-model-chain";
  const baseUrl = (config.openaiBaseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  return baseUrl === "https://api.openai.com" || baseUrl === "https://api.openai.com/v1"
    ? "openai-responses"
    : "openai-compatible";
}

function receiptModelCall(audit, config) {
  return {
    route: audit.route,
    transport: transportFor(audit, config),
    outputSchemaVersion: audit.outputSchemaVersion,
    occurredAt: audit.occurredAt,
    latencyMs: audit.latencyMs,
    usage: {
      inputTokens: audit.usage?.inputTokens ?? null,
      outputTokens: audit.usage?.outputTokens ?? null,
      totalTokens: audit.usage?.totalTokens ?? null,
    },
  };
}

async function readSuccessfulModelAudits(memoryDir) {
  const auditDir = path.join(memoryDir, "state", "support-passport", "audit");
  let names;
  try {
    names = (await readdir(auditDir)).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
  } catch {
    throw new DemoFailure("The live model audit was not saved.");
  }
  const records = [];
  for (const name of names) {
    const lines = (await readFile(path.join(auditDir, name), "utf8")).split("\n").filter(Boolean);
    for (const line of lines) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new DemoFailure("The live model audit contains invalid JSON.");
      }
      const record = SupportPassportModelAuditRecordSchema.safeParse(parsed);
      if (!record.success) throw new DemoFailure("The live model audit does not match its strict schema.");
      records.push(record.data);
    }
  }
  const successful = records.filter((record) => record.outcome === "success");
  const draft = successful.filter((record) => record.operation === "draft_cards");
  const answer = successful.filter((record) => record.operation === "answer_question");
  if (draft.length !== 1 || answer.length !== 1 || records.length !== 2) {
    throw new DemoFailure("The fresh store did not contain exactly two successful model audit records.");
  }
  return { draft: draft[0], answer: answer[0] };
}

function assertNoPrivateReceiptData(receipt, values) {
  const serialized = JSON.stringify(receipt);
  for (const value of values) {
    if (value && serialized.includes(value)) throw new DemoFailure("The receipt privacy check failed.");
  }
}

async function runReserved(options, reservation) {
  const { receiptPath } = reservation;
  const sourceMemories = await readJson(
    path.join(repoRoot, "fixtures/support-passport/source-memories.json"),
    SourceMemoriesFixtureSchema
  );
  const expectedPublicCards = await readJson(
    path.join(repoRoot, "fixtures/support-passport/expected-public-cards.json"),
    ExpectedPublicCardsFixtureSchema
  );
  const commitSha = await readCleanCommitSha(repoRoot, (args, execOptions) => execFileAsync("git", args, execOptions));
  const sourceConfig = resolveInputConfig(options);
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "remnic-support-passport-live-"));
  const memoryDir = path.join(tempRoot, "memory");
  const configPath = path.join(tempRoot, "config.json");
  const authToken = randomBytes(32).toString("base64url");
  const restoreDemoEnvironment = isolateEnvironmentVariables(DEMO_ENVIRONMENT_KEYS);
  let server;
  let runFailed = false;
  let runError;

  try {
    process.env.REMNIC_MEMORY_DIR = memoryDir;
    const port = await findAvailablePort();
    const derivedConfig = {
      remnic: isolateDemoRemnicConfig(sourceConfig.remnic, memoryDir, resolveEnvVars),
      server: {
        host: "127.0.0.1",
        port,
        authToken,
        principal: "support-passport-demo-owner",
        writeRateLimitMaxRequests: 60,
        writeRateLimitWindowMs: 60_000,
        adminConsoleEnabled: false,
      },
    };
    await writeFile(configPath, `${JSON.stringify(derivedConfig)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    server = await startServer({ configPath, host: "127.0.0.1", port, authToken });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const headers = ownerHeaders(authToken);
    const modelTimeoutMs = modelRequestTimeoutMs(
      resolveSupportPassportModelRoutePlan(server.config),
      server.config.localLlmTimeoutMs
    );
    await waitForReady(baseUrl, authToken);

    console.log("[1/9] Started a fresh loopback Remnic server.");
    const sourceMemoryIds = [];
    const sourceMemoryRevisions = [];
    for (const memory of sourceMemories.memories) {
      const imported = await requestJson(
        `${baseUrl}/engram/v1/memories`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            schemaVersion: 1,
            idempotencyKey: `support-passport-demo-${memory.fixtureId}`,
            content: memory.content,
            category: memory.category,
            tags: memory.tags,
            sourceReason: "support-passport-demo",
          }),
        },
        201,
        "Fixture import"
      );
      const memoryId = parseBody(MemoryStoreResponseSchema, imported, "Fixture import").memoryId;
      sourceMemoryIds.push(memoryId);
      const previewRequest = await requestJson(
        `${baseUrl}/engram/v1/support-passport/memories/${encodeURIComponent(memoryId)}`,
        { method: "GET", headers },
        200,
        "Memory preview"
      );
      const preview = parseBody(MemoryPreviewResponseSchema, previewRequest, "Memory preview").memory;
      if (preview.id !== memoryId || preview.content !== memory.content) {
        throw new DemoFailure("A reviewed memory did not match the imported fixture.");
      }
      sourceMemoryRevisions.push({ memoryId, revision: preview.revision });
    }
    console.log(`[2/9] Imported and reviewed ${sourceMemoryIds.length} synthetic memories.`);

    const draftedRequest = await requestJson(
      `${baseUrl}/engram/v1/support-passport/drafts/generate`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ sourceMemoryIds, sourceMemoryRevisions, consent: true }),
      },
      200,
      "Model draft",
      modelTimeoutMs
    );
    const drafted = parseBody(DraftResponseSchema, draftedRequest, "Model draft");
    if (drafted.cards.some((card) => card.status !== "pending_review")) {
      throw new DemoFailure("A generated card did not start as pending review.");
    }
    console.log(`[3/9] Drafted ${drafted.cards.length} support cards through the configured model route.`);

    const firstDraft = drafted.cards[0];
    const expectedCard = expectedPublicCards.cards[0];
    const reviewBy = new Date(Date.now() + 180 * 24 * 60 * 60 * 1_000).toISOString();
    const editedRequest = await requestJson(
      `${baseUrl}/engram/v1/support-passport/cards/${encodeURIComponent(firstDraft.cardId)}`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({ ...expectedCard, reviewBy, expectedRevision: firstDraft.revision }),
      },
      200,
      "Owner edit"
    );
    const edited = parseBody(CardResponseSchema, editedRequest, "Owner edit").card;
    if (edited.status !== "pending_review" || edited.revision === firstDraft.revision) {
      throw new DemoFailure("The owner edit did not create a distinct pending revision.");
    }

    const approvedRequest = await requestJson(
      `${baseUrl}/engram/v1/support-passport/cards/${encodeURIComponent(edited.cardId)}/approve`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ expectedRevision: edited.revision, reasonCode: "owner-approved" }),
      },
      200,
      "Owner approval"
    );
    const approved = parseBody(CardResponseSchema, approvedRequest, "Owner approval").card;
    if (approved.status !== "active" || approved.revision === edited.revision) {
      throw new DemoFailure("The owner approval did not create a distinct active revision.");
    }
    console.log("[4/9] Edited and approved one card as the owner.");

    const requestedExpiry = new Date(
      Date.now() + Math.max(2 * 60 * 60 * 1_000, modelTimeoutMs + GRANT_MODEL_MARGIN_MS)
    ).toISOString();
    const grantRequest = await requestJson(
      `${baseUrl}/engram/v1/support-passport/grants`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          cardIds: [approved.cardId],
          cardRevisions: [{ cardId: approved.cardId, revision: approved.revision }],
          expiresAt: requestedExpiry,
        }),
      },
      200,
      "Share link creation"
    );
    const grant = parseBody(GrantResponseSchema, grantRequest, "Share link creation");
    console.log("[5/9] Created a share link that covers the configured model budget.");

    const publicUrl = `${baseUrl}/engram/v1/support-passport/public/grants/${encodeURIComponent(grant.grantId)}`;
    const helperReadRequest = await requestJson(
      publicUrl,
      { method: "GET", headers: helperHeaders(grant.secret) },
      200,
      "Helper read"
    );
    assertPrivateHelperResponse(helperReadRequest.response, "Helper read");
    const guide = parseBody(SupportPassportPublicGuideSchema, helperReadRequest, "Helper read");
    if (
      guide.cards.length !== 1 ||
      guide.cards[0].cardId !== approved.cardId ||
      guide.cards[0].title !== expectedCard.title ||
      guide.cards[0].statement !== expectedCard.statement ||
      guide.cards[0].category !== expectedCard.category
    ) {
      throw new DemoFailure("The helper view did not contain the exact approved card.");
    }
    console.log("[6/9] Opened only the approved card without owner auth.");

    const helperAskRequest = await requestJson(
      `${publicUrl}/ask`,
      {
        method: "POST",
        headers: helperHeaders(grant.secret, true),
        body: JSON.stringify({ question: expectedPublicCards.question }),
      },
      200,
      "Helper question",
      modelTimeoutMs
    );
    assertPrivateHelperResponse(helperAskRequest.response, "Helper question");
    const answer = parseBody(SupportPassportAnswerOutputSchema, helperAskRequest, "Helper question");
    if (
      answer.coverage !== expectedPublicCards.expectedCoverage ||
      answer.citedCardIds.length !== 1 ||
      answer.citedCardIds[0] !== approved.cardId
    ) {
      throw new DemoFailure("The helper answer was not grounded in the one approved card.");
    }
    console.log("[7/9] Received one grounded answer with one card citation.");

    const revokeRequest = await requestJson(
      `${baseUrl}/engram/v1/support-passport/grants/${encodeURIComponent(grant.grantId)}/revoke`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ expectedVersion: grant.version }),
      },
      200,
      "Stop sharing"
    );
    const revoked = parseBody(RevokeResponseSchema, revokeRequest, "Stop sharing");
    console.log("[8/9] Stopped sharing as the owner.");

    const deniedReadRequest = await requestJson(
      publicUrl,
      { method: "GET", headers: helperHeaders(grant.secret) },
      410,
      "Denied helper read"
    );
    assertPrivateHelperResponse(deniedReadRequest.response, "Denied helper read");
    if (
      !deniedReadRequest.body ||
      typeof deniedReadRequest.body !== "object" ||
      deniedReadRequest.body.code !== "grant_gone" ||
      Object.hasOwn(deniedReadRequest.body, "cards")
    ) {
      throw new DemoFailure("The stopped link did not fail closed.");
    }
    const forbiddenDeniedText = [
      ...sourceMemories.memories.map((memory) => memory.content),
      expectedCard.title,
      expectedCard.statement,
      answer.answer,
    ];
    if (forbiddenDeniedText.some((value) => deniedReadRequest.rawBody.includes(value))) {
      throw new DemoFailure("The stopped link returned private content.");
    }
    console.log("[9/9] Confirmed the stopped link returns 410 with no card content.");

    const audits = await waitForResult(() => readSuccessfulModelAudits(memoryDir));
    const responses = {
      draft: draftedRequest.receiptEntry,
      edit: editedRequest.receiptEntry,
      approve: approvedRequest.receiptEntry,
      grant: grantRequest.receiptEntry,
      helperRead: helperReadRequest.receiptEntry,
      helperAsk: helperAskRequest.receiptEntry,
      revoke: revokeRequest.receiptEntry,
      deniedRead: deniedReadRequest.receiptEntry,
    };
    const receipt = SupportPassportReceiptSchema.parse({
      schemaVersion: 1,
      validationScope: "self_consistency_only",
      fixtureHash: computeFixtureHash(sourceMemories, expectedPublicCards),
      commitSha,
      generatedAt: new Date().toISOString(),
      cardRevisions: {
        drafted: drafted.cards.map((card) => RevisionSchema.parse(card.revision)),
        edited: { cardId: edited.cardId, revision: RevisionSchema.parse(edited.revision) },
        approved: [{ cardId: approved.cardId, revision: RevisionSchema.parse(approved.revision) }],
      },
      grant: { grantId: grant.grantId, expiresAt: grant.expiresAt },
      modelCalls: {
        draft: receiptModelCall(audits.draft, server.config),
        answer: receiptModelCall(audits.answer, server.config),
      },
      revokedAt: revoked.revokedAt,
      httpStatusSequence: receiptStatusSequence(responses),
      responses,
      responseHashChain: computeResponseHashChain(responses),
      finalResult: "passed",
    });
    assertNoPrivateReceiptData(receipt, [
      authToken,
      grant.secret,
      memoryDir,
      configPath,
      ...sourceMemories.memories.map((memory) => memory.content),
      expectedCard.title,
      expectedCard.statement,
      expectedPublicCards.question,
      answer.answer,
      audits.draft.modelUsed,
      audits.answer.modelUsed,
    ]);

    await reservation.writeReceipt(`${JSON.stringify(receipt, null, 2)}\n`);
    await validateReceiptConsistency({ receiptPath });
    await reservation.retainReceipt();
  } catch (error) {
    runFailed = true;
    runError = error;
  }
  const cleanupError = await runCleanupSteps([
    async () => {
      if (server) await server.stop();
    },
    async () => restoreDemoEnvironment(),
    async () => rm(tempRoot, { recursive: true, force: true }),
  ]);
  if (runFailed) throw runError;
  if (cleanupError) throw cleanupError;
  console.log(`Saved receipt.json and validated its self-consistency for commit ${commitSha}.`);
}

async function run(options) {
  const outputDir = path.resolve(expandTildePath(options.output));
  await runWithReservedOutput(outputDir, (reservation) => runReserved(options, reservation));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  await run(options);
}

main().catch(() => {
  console.error("Live demo failed. Review the last completed step and the selected Remnic configuration.");
  process.exitCode = 1;
});
