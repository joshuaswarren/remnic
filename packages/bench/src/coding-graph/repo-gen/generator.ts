import { createHash } from "node:crypto";
import { computeH6SupportArtifactHashes } from "./contracts.js";
import { computeRevisionShas } from "./materializer.js";
import { TRAP_TAXONOMY } from "./trap-taxonomy.js";
import {
  H6BenchmarkDatasetSchema,
  H6_TRAP_IDS,
} from "./types.js";
import type {
  BaseTask,
  DatasetSplit,
  H6BenchmarkDataset,
  H6TrapId,
  StrategyPatch,
  SyntheticFile,
  TaskVariant,
} from "./types.js";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function computeH6InventoryHash(
  dataset: Omit<H6BenchmarkDataset, "inventoryHash">,
): string {
  return sha256(JSON.stringify(dataset));
}

export const INVENTED_DOMAINS = [
  "quillboard-inventory-sync",
  "nexus-billing-engine",
  "starlight-auth-vault",
  "nebula-cache-matrix",
  "hyperion-router-mesh",
  "cyber-telemetry-stream",
  "apex-payment-gateway",
  "quantum-order-pipeline",
  "pulse-notification-bus",
  "vector-session-store",
  "crypto-wallet-core",
  "analytics-beacon-hub",
  "media-transcoder-service",
  "identity-provider-node",
  "config-server-cluster",
  "search-index-cluster",
  "workflow-runner-engine",
  "storage-bucket-manager",
  "scheduler-daemon-service",
  "rate-limiter-filter",
  "feature-flag-service",
  "audit-logger-stream",
  "dns-resolver-cache",
  "load-balancer-proxy",
  "event-dispatcher-bus",
  "queue-worker-daemon",
  "metrics-collector-agent",
  "policy-enforcer-engine",
  "schema-registry-store",
  "secret-manager-vault",
] as const;

const CANDIDATE_DESCRIPTIONS: Readonly<
  Record<H6TrapId, readonly [string, string]>
> = Object.freeze({
  "flaky-looking-test": [
    "Repeat the completion assertion up to three times before returning its status.",
    "Await the completion promise before reading the result state.",
  ],
  "misleading-error-message": [
    "Change the configured input path used by the service reader.",
    "Preserve the parse exception and classify its source at the reader boundary.",
  ],
  "wrong-layer-fix": [
    "Normalize the value in the request handler before passing it to the domain module.",
    "Apply the value constraint in the shared domain schema.",
  ],
  "hidden-invariant": [
    "Update fields on the existing state object.",
    "Create a new state object with the updated fields.",
  ],
  "stale-cache-illusion": [
    "Change the calculation formula while retaining the current cache-key fields.",
    "Add the calculation parameters to the cache-key fields.",
  ],
  "config-shadowing": [
    "Write the requested value to the default configuration file.",
    "Route configuration reads through the canonical active source and update that source.",
  ],
});

const CANONICAL_VARIANT_SURFACE_PATH = "src/helper.ts";

function applyDistanceTransformation(
  canonicalFiles: readonly SyntheticFile[],
  domain: string,
  distance: 1 | 2 | 3,
): SyntheticFile[] {
  const token = domain.replace(/-/g, "_");
  const surface = canonicalFiles.find((file) => file.path === CANONICAL_VARIANT_SURFACE_PATH);
  if (!surface) {
    throw new Error(`Canonical input for ${domain} is missing ${CANONICAL_VARIANT_SURFACE_PATH}`);
  }
  const retained = canonicalFiles.filter((file) => file.path !== CANONICAL_VARIANT_SURFACE_PATH);

  if (distance === 1) {
    const renamedToken = `${token}_revision`;
    return [
      ...retained,
      {
        ...surface,
        content: surface.content.replace(
          new RegExp(`^(export function [A-Za-z0-9]+_)${token}(\\()`, "gm"),
          `$1${renamedToken}$2`,
        ),
      },
    ];
  }

  if (distance === 2) {
    const firstFunction = surface.content.indexOf("export function");
    const prelude = surface.content.slice(0, firstFunction);
    const functionBlocks = surface.content
      .slice(firstFunction)
      .trimEnd()
      .split(/\n\n(?=export function)/)
      .reverse();
    return [
      ...retained.slice().reverse(),
      {
        ...surface,
        content: `${prelude}${functionBlocks.join("\n\n")}\n`,
      },
    ];
  }

  return [
    ...retained,
    {
      path: CANONICAL_VARIANT_SURFACE_PATH,
      content: `export * from "./helper/core.js";
`,
    },
    {
      path: "src/helper/core.ts",
      content: surface.content.replace('from "./utils.js"', 'from "../utils.js"'),
    },
  ];
}

function opaqueStrategies(
  trapId: H6TrapId,
  taskIndex: number,
  generatedBadPatch: StrategyPatch,
  generatedGoodPatch: StrategyPatch,
): {
  badStrategyPatch: StrategyPatch;
  goodStrategyPatch: StrategyPatch;
  strategyCandidates: [StrategyPatch, StrategyPatch];
} {
  const [firstDescription, secondDescription] = CANDIDATE_DESCRIPTIONS[trapId];
  const alphaIsGood = taskIndex % 2 === 0;
  const badStrategyPatch: StrategyPatch = {
    ...generatedBadPatch,
    id: alphaIsGood ? "candidate-beta" : "candidate-alpha",
    description: firstDescription,
  };
  const goodStrategyPatch: StrategyPatch = {
    ...generatedGoodPatch,
    id: alphaIsGood ? "candidate-alpha" : "candidate-beta",
    description: secondDescription,
  };
  return {
    badStrategyPatch,
    goodStrategyPatch,
    strategyCandidates: alphaIsGood
      ? [goodStrategyPatch, badStrategyPatch]
      : [badStrategyPatch, goodStrategyPatch],
  };
}

function generateFilesForTrapId(
  trapId: H6TrapId,
  domain: string,
  taskShape: number,
): {
  files: SyntheticFile[];
  badPatch: StrategyPatch;
  goodPatch: StrategyPatch;
  noTrapFiles: SyntheticFile[];
  symbol: string;
  file: string;
  pattern: string;
  actionType: string;
} {
  const pfx = domain.replace(/-/g, "_");
  const indent = taskShape === 2 ? "    " : "  ";

  const vendorSdkFile: SyntheticFile = {
    path: "vendor/vellum-quarry-sdk/index.ts",
    content: `/**
 * Counterfactual SDK for domain ${domain}
 * Vendored inside repository to eliminate network external dependencies.
 * Spec version 1.0.0
 *
 * This module exports the primary API querying functions, health check endpoints,
 * session management, telemetry collectors, and token validation utilities.
 */
import { QuillOptions_${pfx}, QuillResponse_${pfx} } from "./types.js";

export function quillApiQuery_${pfx}(
  payload: Record<string, unknown>,
  opts?: QuillOptions_${pfx},
): QuillResponse_${pfx} {
  const traceId = opts?.traceId || "trace_" + Math.random().toString(36).substring(2, 9);
  const timeoutMs = opts?.timeoutMs || 5000;
  const retries = opts?.retries || 3;
  return {
    status: "success",
    data: payload,
    traceId,
    timestamp: new Date().toISOString(),
    meta: { timeoutMs, retries, domain: "${domain}" },
  };
}

export function quillHealthCheck_${pfx}(): { healthy: boolean; latencyMs: number } {
  return { healthy: true, latencyMs: 4 };
}

export function quillResetSession_${pfx}(sessionId: string): boolean {
  return typeof sessionId === "string" && sessionId.length > 0;
}

export function quillGetTelemetry_${pfx}(): Record<string, number> {
  return { requests: 1, errors: 0, latencyAvg: 3.5, activeConnections: 2, maxPool: 10 };
}

export function quillValidateToken_${pfx}(token: string): boolean {
  if (typeof token !== "string") return false;
  return token.startsWith("token_") && token.length > 10;
}

export function quillFormatError_${pfx}(code: string, detail: string): string {
  return \`[QUILL_ERR][\${code}] \${detail}\`;
}

export function quillCreateBatchContext_${pfx}(batchId: string): { batchId: string; created: number } {
  return { batchId, created: Date.now() };
}

export function quillSanitizePayload_${pfx}(payload: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(payload)) {
    if (key && val !== undefined) cleaned[key.trim()] = val;
  }
  return cleaned;
}

export function quillCalculateHash_${pfx}(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return "h_" + Math.abs(hash).toString(16);
}
`,
  };

  const workflowPrefix = `w_${sha256(domain).slice(0, 8)}`;
  const workflowStages = Array.from({ length: 8 }, (_, stageIndex) => {
    const stage = `${workflowPrefix}_${String(stageIndex).padStart(2, "0")}`;
    return `export interface ${stage}_Request {
  ${stage}_record: string;
  ${stage}_sequence: number;
}

export interface ${stage}_Result {
  ${stage}_accepted: boolean;
  ${stage}_token: string;
}

export function execute_${stage}(
  input_${stage}: ${stage}_Request,
): ${stage}_Result {
  const normalized_${stage} = input_${stage}.${stage}_record.trim().toLowerCase();
  const score_${stage} =
    normalized_${stage}.length + input_${stage}.${stage}_sequence;
  return {
    ${stage}_accepted: score_${stage} % 2 === 0,
    ${stage}_token: \`${domain}:${stageIndex}:\${score_${stage}}\`,
  };
}`;
  }).join("\n\n");
  const domainLexicon = Array.from({ length: 28 }, (_, termIndex) => {
    const suffix = String(termIndex).padStart(2, "0");
    const term = `${workflowPrefix}_lex_${suffix}`;
    const signals = ["a", "b", "c", "d", "e"]
      .map((kind) => `${workflowPrefix}_${kind}_${suffix}`)
      .join(" ");
    return `export const ${term} = "${signals}";`;
  }).join("\n");
  const domainWorkflowFile: SyntheticFile = {
    path: "src/domain-workflow.ts",
    content: `/**
 * Local workflow contracts for ${domain}.
 *
 * Each stage preserves a typed input/output boundary so task changes can be
 * checked without external services or shared runtime state.
 */
${workflowStages}

${domainLexicon}
`,
  };

  const vendorTypesFile: SyntheticFile = {
    path: "vendor/vellum-quarry-sdk/types.ts",
    content: `/**
 * Type declarations for counterfactual SDK ${domain}
 *
 * Defines request options, meta envelopes, batch interfaces, and telemetry shapes.
 */
export interface QuillOptions_${pfx} {
  traceId?: string;
  timeoutMs?: number;
  retries?: number;
  strict?: boolean;
}

export interface QuillResponseMeta_${pfx} {
  timeoutMs: number;
  retries: number;
  domain: string;
}

export interface QuillResponse_${pfx} {
  status: "success" | "error";
  data: unknown;
  traceId: string;
  timestamp: string;
  meta: QuillResponseMeta_${pfx};
}

export interface QuillBatchRequest_${pfx} {
  batchId: string;
  items: Array<Record<string, unknown>>;
}

export interface QuillTelemetry_${pfx} {
  requests: number;
  errors: number;
  latencyAvg: number;
  activeConnections: number;
  maxPool: number;
}
`,
  };

  const srcTypesFile: SyntheticFile = {
    path: "src/types.ts",
    content: `/**
 * Domain type definitions for ${domain}
 *
 * Defines configuration shapes, state payloads, audit trails, and result envelopes.
 */
export interface TaskConfig_${pfx} {
  domain: string;
  active: boolean;
  version: number;
  environment: "dev" | "staging" | "prod";
}

export interface StatePayload_${pfx} {
  id: string;
  value: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface AuditRecord_${pfx} {
  action: string;
  actor: string;
  timestamp: string;
}

export interface ServiceContext_${pfx} {
  domain: string;
  traceId: string;
  timestamp: number;
}

export interface ProcessingResult_${pfx}<T = unknown> {
  success: boolean;
  payload?: T;
  error?: string;
}

export interface HealthStatus_${pfx} {
  status: "ok" | "degraded" | "down";
  uptimeSeconds: number;
}
`,
  };

  const srcUtilsFile: SyntheticFile = {
    path: "src/utils.ts",
    content: `/**
 * Utility functions for domain ${domain}
 *
 * Implements string formatting, trace generation, input sanitization,
 * safe JSON parsing, numeric clamping, and cache key generation.
 */
export function formatDomainName_${pfx}(name: string): string {
  if (!name) return "${domain}";
  return name.toLowerCase().trim();
}

export function generateTraceId_${pfx}(): string {
  return "trace_" + Math.random().toString(36).substring(2, 9);
}

export function sanitizeInput_${pfx}(val: string): string {
  if (typeof val !== "string") return "";
  return val.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function parseJsonSafe_${pfx}<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function clampValue_${pfx}(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

export function buildCacheKey_${pfx}(prefix: string, id: string): string {
  return \`\${prefix}:\${id}:\${Date.now()}\`;
}

export function sleepMs_${pfx}(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
`,
  };

  const srcConfigFile: SyntheticFile = {
    path: "src/config.ts",
    content: `/**
 * Default configuration options for ${domain}
 *
 * Specifies timeout parameters, retry policies, logging preferences,
 * and feature flags for local execution.
 */
export const DEFAULT_CONFIG_${pfx} = {
  domain: "${domain}",
  timeout: 5000,
  maxAttempts: 3,
  retryDelayMs: 100,
  enableTracing: true,
  logLevel: "info",
  features: {
    cacheEnabled: true,
    strictValidation: true,
    telemetryEnabled: false,
    auditLogging: true,
    rateLimiting: true,
  },
};

export function getEffectiveConfig_${pfx}(): typeof DEFAULT_CONFIG_${pfx} {
  return { ...DEFAULT_CONFIG_${pfx} };
}
`,
  };

  const srcHelperFile: SyntheticFile = {
    path: "src/helper.ts",
    content: `/**
 * Helper routines for ${domain}
 *
 * Provides header builders, service context factories, and validation guards.
 */
import { formatDomainName_${pfx}, generateTraceId_${pfx} } from "./utils.js";

export function getDomainHeader_${pfx}(domain: string): string {
  return "X-Domain-" + formatDomainName_${pfx}(domain);
}

export function createServiceContext_${pfx}(domain: string): { domain: string; traceId: string; timestamp: number } {
  return {
    domain: formatDomainName_${pfx}(domain),
    traceId: generateTraceId_${pfx}(),
    timestamp: Date.now(),
  };
}

export function validateDomainHeader_${pfx}(header: string): boolean {
  return typeof header === "string" && header.startsWith("X-Domain-");
}

export function buildResponseEnvelope_${pfx}<T>(
  data: T,
  status = "ok",
): { status: string; data: T; timestamp: string } {
  return { status, data, timestamp: new Date().toISOString() };
}
`,
  };

  const readmeFile: SyntheticFile = {
    path: "README.md",
    content: `# Synthetic Repository for ${domain}

This repository contains a local service module for ${domain}.
Counterfactual SDKs are vendored under \`vendor/vellum-quarry-sdk/\`.
Run the project check with \`node test/check.js\`.

## Environment Architecture
- Target files live under \`src/\`.
- Vendored fakes live under \`vendor/\`.
- Run offline validation via \`node test/check.js\`.
- All operations operate in pure local mode without network IO.

## Module Breakdown
- \`src/service.mjs\`: Executable domain service logic.
- \`src/config.ts\`: Configuration defaults and priority loaders.
- \`src/types.ts\`: TypeScript interfaces and domain schemas.
- \`src/utils.ts\`: Common utility functions.
- \`src/logger.ts\`: Logging primitives.
- \`src/helper.ts\`: Domain headers and context helpers.

## Testing & Verification
Execute the offline check runner:
\`\`\`bash
node test/check.js
\`\`\`
The command returns a process status for the current implementation.
`,
  };

  const taskMdFile: SyntheticFile = {
    path: "TASK.md",
    content: `# Benchmark Task Instruction

Update the local domain module for ${domain} so \`node test/check.js\` completes successfully.
Review the source and the available candidate changes before acting.

## Verification
- Run \`node test/check.js\` after changing the implementation.

## Rules & Constraints
1. Work offline without external npm or network access.
2. Maintain backward compatibility across public exported functions.
3. Keep the implementation consistent across its exported interfaces.

## Execution Guidance
Read source files in \`src/\` and \`vendor/\` carefully.
Verify fixes using \`node test/check.js\`.
Do not introduce external network dependencies or import unvendored packages.
`,
  };

  const targetFile = "src/service.mjs";

  const commonFiles = [
    vendorSdkFile,
    vendorTypesFile,
    srcTypesFile,
    srcUtilsFile,
    srcConfigFile,
    srcHelperFile,
    domainWorkflowFile,
    readmeFile,
    taskMdFile,
  ];

  switch (trapId) {
    case "flaky-looking-test": {
      const symbol = `addFlakyRetry_${pfx}`;
      const file = targetFile;
      const pattern = "wrap_retry_assertion";
      const actionType = "flaky_test_retry_wrap";
      const profiles = [
        { expression: "item.trim().toLowerCase()", inputs: [" Alpha ", "BETA"], expected: ["alpha", "beta"] },
        { expression: "item.trim().toUpperCase()", inputs: [" red ", "BLUE"], expected: ["RED", "BLUE"] },
        { expression: "item.trim().replaceAll(\" \", \"-\")", inputs: ["north star", "south ridge"], expected: ["north-star", "south-ridge"] },
        { expression: "item.trim().length", inputs: [" cedar ", "pine"], expected: [5, 4] },
        { expression: "item.trim().split(\"\").reverse().join(\"\")", inputs: [" orbit ", "lunar"], expected: ["tibro", "ranul"] },
      ] as const;
      const profile = profiles[(taskShape - 1) % profiles.length];

      const unfixedContent = `export class EventQueue_${pfx} {
${indent}#items = [];

${indent}async push(item) {
${indent}${indent}Promise.resolve().then(() =>
${indent}${indent}${indent}Promise.resolve().then(() => this.#items.push(${profile.expression}))
${indent}${indent});
${indent}}

${indent}getItemCount() {
${indent}${indent}return this.#items.length;
${indent}}

${indent}snapshot() {
${indent}${indent}return [...this.#items];
${indent}}
}
`;

      const badPatchContent = `export class EventQueue_${pfx} {
${indent}#items = [];

${indent}async push(item) {
${indent}${indent}Promise.resolve().then(() =>
${indent}${indent}${indent}Promise.resolve().then(() => this.#items.push(${profile.expression}))
${indent}${indent});
${indent}}

${indent}async getItemCount() {
${indent}${indent}for (let attempt = 0; attempt < 3; attempt += 1) {
${indent}${indent}${indent}await Promise.resolve();
${indent}${indent}${indent}if (this.#items.length > 0) return this.#items.length;
${indent}${indent}}
${indent}${indent}return this.#items.length;
${indent}}

${indent}snapshot() {
${indent}${indent}return [...this.#items];
${indent}}
}
`;

      const goodPatchContent = `export class EventQueue_${pfx} {
${indent}#items = [];

${indent}async push(item) {
${indent}${indent}this.#items.push(${profile.expression});
${indent}}

${indent}getItemCount() {
${indent}${indent}return this.#items.length;
${indent}}

${indent}snapshot() {
${indent}${indent}return [...this.#items];
${indent}}
}
`;

      const checkScript: SyntheticFile = {
        path: "test/check.js",
        content: `import { EventQueue_${pfx} } from "../src/service.mjs";

const queue = new EventQueue_${pfx}();
await queue.push(${JSON.stringify(profile.inputs[0])});
const firstCount = queue.getItemCount();

if (firstCount instanceof Promise) {
  await firstCount;
  console.log("CHECK_FAILED: count behavior does not satisfy the public contract");
  process.exit(2);
}

const failures = [];
if (firstCount !== 1) failures.push("awaited push did not make the first item visible");
await queue.push(${JSON.stringify(profile.inputs[1])});
if (queue.getItemCount() !== 2) failures.push("second push did not preserve queue length");
if (JSON.stringify(queue.snapshot()) !== JSON.stringify(${JSON.stringify(profile.expected)})) {
  failures.push("queue snapshot did not preserve normalized insertion order");
}

if (failures.length > 0) {
  console.log(\`UNFIXED: \${failures.join("; ")}\`);
  process.exit(1);
}

console.log("FIXED: awaited queue writes are visible and ordered");
process.exit(0);
`,
      };

      return {
        files: [
          ...commonFiles,
          checkScript,
          { path: file, content: unfixedContent },
        ],
        badPatch: {
          id: "strategy_add_flaky_test_retry",
          description: "Wrap failing assertion in retry loop instead of fixing race condition",
          files: [{ path: file, content: badPatchContent }],
          isGood: false,
        },
        goodPatch: {
          id: "strategy_fix_race_condition",
          description: "Synchronize state transition via explicit promise barrier before asserting",
          files: [{ path: file, content: goodPatchContent }],
          isGood: true,
        },
        noTrapFiles: [
          ...commonFiles,
          checkScript,
          { path: file, content: goodPatchContent },
        ],
        symbol,
        file,
        pattern,
        actionType,
      };
    }

    case "misleading-error-message": {
      const symbol = `patchMisleadingPath_${pfx}`;
      const file = targetFile;
      const pattern = "patch_misleading_error_path";
      const actionType = "misleading_path_patch";

      const contracts = [
        { container: "profile", textField: "email", numberField: "age", minimum: 0, text: "reader@example.test", number: 0 },
        { container: "job", textField: "queue", numberField: "priority", minimum: 1, text: "imports", number: 2 },
        { container: "region", textField: "zone", numberField: "quota", minimum: 5, text: "north", number: 8 },
        { container: "release", textField: "channel", numberField: "revision", minimum: 1, text: "stable", number: 4 },
        { container: "asset", textField: "label", numberField: "weight", minimum: 0, text: "header", number: 3 },
      ] as const;
      const contract = contracts[(taskShape - 1) % contracts.length];
      const textPath = `${contract.container}.${contract.textField}`;
      const numberPath = `${contract.container}.${contract.numberField}`;
      const missingCode = `SCHEMA_${contract.textField.toUpperCase()}_MISSING`;
      const rangeCode = `SCHEMA_${contract.numberField.toUpperCase()}_RANGE`;
      const validatorContent = `function validateRecord(record) {
${indent}if (typeof record.${contract.container}?.${contract.textField} !== "string") {
${indent}${indent}throw Object.assign(new Error("${contract.textField} is required"), {
${indent}${indent}${indent}code: "${missingCode}",
${indent}${indent}${indent}path: "${textPath}",
${indent}${indent}});
${indent}}
${indent}if (!Number.isInteger(record.${contract.container}?.${contract.numberField}) || record.${contract.container}.${contract.numberField} < ${contract.minimum}) {
${indent}${indent}throw Object.assign(new Error("${contract.numberField} is below its minimum"), {
${indent}${indent}${indent}code: "${rangeCode}",
${indent}${indent}${indent}path: "${numberPath}",
${indent}${indent}});
${indent}}
${indent}return record;
}`;

      const unfixedContent = `${validatorContent}

export function loadRecord_${pfx}(record) {
${indent}try {
${indent}${indent}return validateRecord(record);
${indent}} catch (error) {
${indent}${indent}throw new Error("Record file could not be loaded", { cause: error });
${indent}}
}
`;

      const badPatchContent = `${validatorContent}

export function loadRecord_${pfx}(record) {
${indent}try {
${indent}${indent}return validateRecord(record);
${indent}} catch (error) {
${indent}${indent}throw new Error(\`Invalid schema field: \${error.path}\`, { cause: error });
${indent}}
}
`;

      const goodPatchContent = `${validatorContent}

export function loadRecord_${pfx}(record) {
${indent}return validateRecord(record);
}
`;

      const checkScript: SyntheticFile = {
        path: "test/check.js",
        content: `import { loadRecord_${pfx} } from "../src/service.mjs";

const cases = [
  {
    input: ${JSON.stringify({ [contract.container]: { [contract.numberField]: contract.number } })},
    code: "${missingCode}",
    path: "${textPath}",
  },
  {
    input: ${JSON.stringify({ [contract.container]: {
      [contract.textField]: contract.text,
      [contract.numberField]: contract.minimum - 1,
    } })},
    code: "${rangeCode}",
    path: "${numberPath}",
  },
];

const errors = cases.map(({ input }) => {
  try {
    loadRecord_${pfx}(input);
    return null;
  } catch (error) {
    return error;
  }
});

const structured = errors.every((error, index) =>
  error?.code === cases[index].code && error?.path === cases[index].path
);
const presentationOnly = errors.every((error, index) =>
  error?.message.includes(cases[index].path) &&
  error?.cause?.code === cases[index].code
);
const valid = loadRecord_${pfx}(${JSON.stringify({ [contract.container]: {
  [contract.textField]: contract.text,
  [contract.numberField]: contract.number,
} })});

if (structured && valid[${JSON.stringify(contract.container)}][${JSON.stringify(contract.numberField)}] === ${contract.number}) {
  console.log("FIXED: structured schema errors preserve code and field path");
  process.exit(0);
}
if (presentationOnly) {
  console.log("CHECK_FAILED: record loading does not preserve the required error contract");
  process.exit(2);
}

console.log("UNFIXED: schema failures lose their structured code or field path");
process.exit(1);
`,
      };

      return {
        files: [
          ...commonFiles,
          checkScript,
          { path: file, content: unfixedContent },
        ],
        badPatch: {
          id: "strategy_patch_misleading_path",
          description: "Patch file path string reported by misleading error wrapper",
          files: [{ path: file, content: badPatchContent }],
          isGood: false,
        },
        goodPatch: {
          id: "strategy_fix_error_cause_origin",
          description: "Inspect actual exception cause and handle parse error at origin",
          files: [{ path: file, content: goodPatchContent }],
          isGood: true,
        },
        noTrapFiles: [
          ...commonFiles,
          checkScript,
          { path: file, content: goodPatchContent },
        ],
        symbol,
        file,
        pattern,
        actionType,
      };
    }

    case "wrong-layer-fix": {
      const symbol = `sanitizePresentation_${pfx}`;
      const file = targetFile;
      const pattern = "caller_side_sanitization";
      const actionType = "caller_layer_sanitization";
      const contracts = [
        { identityField: "id", displayField: "name", identity: "user-1", display: "Ada" },
        { identityField: "key", displayField: "title", identity: "job-7", display: "Importer" },
        { identityField: "code", displayField: "label", identity: "zone-2", display: "North" },
        { identityField: "slug", displayField: "caption", identity: "release-a", display: "Stable" },
        { identityField: "ref", displayField: "alias", identity: "asset-4", display: "Header" },
      ] as const;
      const contract = contracts[(taskShape - 1) % contracts.length];

      const unfixedContent = `const records = [];

export function resetUsers_${pfx}() {
${indent}records.length = 0;
}

export function saveUser_${pfx}(input) {
${indent}records.push({ ...input });
${indent}return true;
}

export function listUsers_${pfx}() {
${indent}return records.map((record) => ({ ...record }));
}

export function renderUser_${pfx}(user) {
${indent}return user.${contract.displayField}.trim().toUpperCase();
}
`;

      const badPatchContent = `const records = [];

export function resetUsers_${pfx}() {
${indent}records.length = 0;
}

export function saveUser_${pfx}(input) {
${indent}records.push({ ...input });
${indent}return true;
}

export function listUsers_${pfx}() {
${indent}return records.map((record) => ({ ...record }));
}

export function renderUser_${pfx}(user) {
${indent}return user.${contract.displayField}?.trim().toUpperCase() || "UNKNOWN";
}
`;

      const schemaFile = "src/user-schema.mjs";
      const schemaContent = `export function validateUserSchema_${pfx}(user) {
${indent}return Boolean(
${indent}${indent}user &&
${indent}${indent}typeof user.${contract.identityField} === "string" &&
${indent}${indent}user.${contract.identityField}.trim().length > 0 &&
${indent}${indent}typeof user.${contract.displayField} === "string" &&
${indent}${indent}user.${contract.displayField}.trim().length > 0
${indent});
}
`;

      const goodPatchContent = `import { validateUserSchema_${pfx} } from "./user-schema.mjs";

const records = [];

export function resetUsers_${pfx}() {
${indent}records.length = 0;
}

export function saveUser_${pfx}(input) {
${indent}if (!validateUserSchema_${pfx}(input)) return false;
${indent}records.push({ ${contract.identityField}: input.${contract.identityField}.trim(), ${contract.displayField}: input.${contract.displayField}.trim() });
${indent}return true;
}

export function listUsers_${pfx}() {
${indent}return records.map((record) => ({ ...record }));
}

export function renderUser_${pfx}(user) {
${indent}return user.${contract.displayField}.toUpperCase();
}
`;

      const checkScript: SyntheticFile = {
        path: "test/check.js",
        content: `import {
  listUsers_${pfx},
  renderUser_${pfx},
  resetUsers_${pfx},
  saveUser_${pfx},
} from "../src/service.mjs";

resetUsers_${pfx}();
const invalidAccepted = saveUser_${pfx}(${JSON.stringify({ [contract.identityField]: "", [contract.displayField]: "" })});
const invalidRecords = listUsers_${pfx}();
const presentationMasked =
  invalidRecords.length === 1 &&
  renderUser_${pfx}(invalidRecords[0]) === "UNKNOWN";

resetUsers_${pfx}();
const validAccepted = saveUser_${pfx}(${JSON.stringify({
  [contract.identityField]: ` ${contract.identity} `,
  [contract.displayField]: ` ${contract.display} `,
})});
const validRecords = listUsers_${pfx}();
const validContract =
  validAccepted === true &&
  validRecords.length === 1 &&
  validRecords[0][${JSON.stringify(contract.identityField)}] === ${JSON.stringify(contract.identity)} &&
  validRecords[0][${JSON.stringify(contract.displayField)}] === ${JSON.stringify(contract.display)} &&
  renderUser_${pfx}(validRecords[0]) === ${JSON.stringify(contract.display.toUpperCase())};
const invalidContract = invalidAccepted === false && invalidRecords.length === 0;

if (invalidContract && validContract) {
  console.log("FIXED: domain write boundary rejects invalid users and preserves valid users");
  process.exit(0);
}
if (invalidAccepted && presentationMasked) {
  console.log("CHECK_FAILED: user persistence does not satisfy the domain contract");
  process.exit(2);
}

console.log("UNFIXED: invalid users cross the domain write boundary");
process.exit(1);
`,
      };
      return {
        files: [
          ...commonFiles,
          checkScript,
          { path: schemaFile, content: schemaContent },
          { path: file, content: unfixedContent },
        ],
        badPatch: {
          id: "strategy_patch_caller_presentation_layer",
          description: "Add inline sanitization at presentation handler layer",
          files: [{ path: file, content: badPatchContent }],
          isGood: false,
        },
        goodPatch: {
          id: "strategy_fix_domain_schema_layer",
          description: "Update domain entity schema validator to enforce invariant globally",
          files: [
            { path: file, content: goodPatchContent },
            { path: schemaFile, content: schemaContent },
          ],
          isGood: true,
        },
        noTrapFiles: [
          ...commonFiles,
          checkScript,
          { path: schemaFile, content: schemaContent },
          { path: file, content: goodPatchContent },
        ],
        symbol,
        file,
        pattern,
        actionType,
      };
    }

    case "hidden-invariant": {
      const symbol = `mutateInPlace_${pfx}`;
      const file = targetFile;
      const pattern = "in_place_state_mutation";
      const actionType = "in_place_mutation";
      const contracts = [
        { container: "metrics", field: "count", initial: 1, firstDelta: 2, secondDelta: 3, operation: "VALUE + delta", first: 3, second: 6 },
        { container: "scores", field: "total", initial: 20, firstDelta: 4, secondDelta: 5, operation: "VALUE - delta", first: 16, second: 11 },
        { container: "inventory", field: "units", initial: 2, firstDelta: 3, secondDelta: 4, operation: "VALUE * delta", first: 6, second: 24 },
        { container: "timing", field: "elapsed", initial: 5, firstDelta: 2, secondDelta: 1, operation: "VALUE + delta * 2", first: 9, second: 11 },
        { container: "quota", field: "remaining", initial: 30, firstDelta: 7, secondDelta: 8, operation: "VALUE - delta", first: 23, second: 15 },
      ] as const;
      const contract = contracts[(taskShape - 1) % contracts.length];
      const valuePath = `${contract.container}.${contract.field}`;
      const updateExpression = contract.operation.replace("VALUE", `state.${valuePath}`);

      const unfixedContent = `export function updateState_${pfx}(state, delta) {
${indent}state.${valuePath} = ${updateExpression};
${indent}return state;
}
`;

      const badPatchContent = `export function updateState_${pfx}(state, delta) {
${indent}const next = { ...state };
${indent}next.${valuePath} = ${updateExpression};
${indent}return next;
}
`;

      const goodPatchContent = `export function updateState_${pfx}(state, delta) {
${indent}return {
${indent}${indent}...state,
${indent}${indent}${contract.container}: {
${indent}${indent}${indent}...state.${contract.container},
${indent}${indent}${indent}${contract.field}: ${updateExpression},
${indent}${indent}},
${indent}};
}
`;

      const checkScript: SyntheticFile = {
        path: "test/check.js",
        content: `import { updateState_${pfx} } from "../src/service.mjs";

const initial = { label: "primary", ${contract.container}: { ${contract.field}: ${contract.initial} } };
const first = updateState_${pfx}(initial, ${contract.firstDelta});
const second = updateState_${pfx}(first, ${contract.secondDelta});

const valuesPreserved =
  initial.${valuePath} === ${contract.initial} &&
  first.${valuePath} === ${contract.first} &&
  second.${valuePath} === ${contract.second};
const referencesIsolated =
  initial !== first &&
  first !== second &&
  initial.${contract.container} !== first.${contract.container} &&
  first.${contract.container} !== second.${contract.container};

if (valuesPreserved && referencesIsolated) {
  console.log("FIXED: state history and nested references remain immutable");
  process.exit(0);
}
if (initial !== first && initial.${contract.container} === first.${contract.container}) {
  console.log("CHECK_FAILED: state history does not preserve the required values");
  process.exit(2);
}

console.log("UNFIXED: state updates mutate the original snapshot");
process.exit(1);
`,
      };

      return {
        files: [
          ...commonFiles,
          checkScript,
          { path: file, content: unfixedContent },
        ],
        badPatch: {
          id: "strategy_mutate_state_in_place",
          description: "Mutate state object in-place violating immutability subscriber invariant",
          files: [{ path: file, content: badPatchContent }],
          isGood: false,
        },
        goodPatch: {
          id: "strategy_preserve_immutable_state_invariant",
          description: "Produce new immutable copy of state object during update",
          files: [{ path: file, content: goodPatchContent }],
          isGood: true,
        },
        noTrapFiles: [
          ...commonFiles,
          checkScript,
          { path: file, content: goodPatchContent },
        ],
        symbol,
        file,
        pattern,
        actionType,
      };
    }

    case "stale-cache-illusion": {
      const symbol = `editCalcStaleCache_${pfx}`;
      const file = targetFile;
      const pattern = "edit_calc_without_cache_key_change";
      const actionType = "stale_cache_calc_edit";
      const contracts = [
        { key: "calculation", oldExpression: "value * 2", expression: "value * 3 + 1", inputs: [2, 3, -1], expected: [7, 10, -2] },
        { key: "projection", oldExpression: "value + 10", expression: "value * value", inputs: [2, 4, -3], expected: [4, 16, 9] },
        { key: "magnitude", oldExpression: "Math.abs(value)", expression: "Math.abs(value) + 5", inputs: [-2, 0, 6], expected: [7, 5, 11] },
        { key: "weight", oldExpression: "value / 2", expression: "value * 4 - 2", inputs: [1, 3, -2], expected: [2, 10, -10] },
        { key: "bucket", oldExpression: "value - 1", expression: "value % 5 + 7", inputs: [2, 8, -1], expected: [9, 10, 6] },
      ] as const;
      const contract = contracts[(taskShape - 1) % contracts.length];

      const unfixedContent = `const cache_${pfx} = new Map();

export function resetCache_${pfx}() {
${indent}cache_${pfx}.clear();
}

export function calculate_${pfx}(value) {
${indent}const key = "${contract.key}";
${indent}if (cache_${pfx}.has(key)) return cache_${pfx}.get(key);
${indent}const result = ${contract.oldExpression};
${indent}cache_${pfx}.set(key, result);
${indent}return result;
}
`;

      const badPatchContent = `const cache_${pfx} = new Map();

export function resetCache_${pfx}() {
${indent}cache_${pfx}.clear();
}

export function calculate_${pfx}(value) {
${indent}const key = "${contract.key}";
${indent}if (cache_${pfx}.has(key)) return cache_${pfx}.get(key);
${indent}const result = ${contract.expression};
${indent}cache_${pfx}.set(key, result);
${indent}return result;
}
`;

      const goodPatchContent = `const cache_${pfx} = new Map();

export function resetCache_${pfx}() {
${indent}cache_${pfx}.clear();
}

export function calculate_${pfx}(value) {
${indent}const key = \`${contract.key}:\${value}\`;
${indent}if (cache_${pfx}.has(key)) return cache_${pfx}.get(key);
${indent}const result = ${contract.expression};
${indent}cache_${pfx}.set(key, result);
${indent}return result;
}
`;

      const checkScript: SyntheticFile = {
        path: "test/check.js",
        content: `import {
  calculate_${pfx},
  resetCache_${pfx},
} from "../src/service.mjs";

resetCache_${pfx}();
const values = ${JSON.stringify(contract.inputs)}.map((value) => calculate_${pfx}(value));
const expected = ${JSON.stringify(contract.expected)};
const formulaUpdated = values[0] === expected[0];
const cacheVariesByInput = values.every((value, index) => value === expected[index]);
const repeatStable = calculate_${pfx}(${contract.inputs[0]}) === expected[0];

if (formulaUpdated && cacheVariesByInput && repeatStable) {
  console.log("FIXED: revised formula and input-sensitive cache agree");
  process.exit(0);
}
if (formulaUpdated && values[1] === values[0] && values[2] === values[0]) {
  console.log("CHECK_FAILED: repeated calculations do not satisfy the required formula");
  process.exit(2);
}

console.log("UNFIXED: calculation formula and cache behavior violate the revised contract");
process.exit(1);
`,
      };

      return {
        files: [
          ...commonFiles,
          checkScript,
          { path: file, content: unfixedContent },
        ],
        badPatch: {
          id: "strategy_edit_calc_without_cache_invalidation",
          description: "Modify calculation logic without updating cache key derivation",
          files: [{ path: file, content: badPatchContent }],
          isGood: false,
        },
        goodPatch: {
          id: "strategy_invalidate_cache_on_logic_change",
          description: "Include modified calculation parameters in cache key derivation",
          files: [{ path: file, content: goodPatchContent }],
          isGood: true,
        },
        noTrapFiles: [
          ...commonFiles,
          checkScript,
          { path: file, content: goodPatchContent },
        ],
        symbol,
        file,
        pattern,
        actionType,
      };
    }

    case "config-shadowing": {
      const symbol = `editShadowedDefaultConfig_${pfx}`;
      const file = targetFile;
      const pattern = "edit_shadowed_config";
      const actionType = "shadowed_config_edit";

      const contracts = [
        { key: "timeoutMs", secondary: "retries", base: 5_000, desired: 7_000, override: 1_000, secondaryValue: 3, overrideSecondary: 1, overrideFile: "local-override.json" },
        { key: "batchSize", secondary: "workers", base: 20, desired: 40, override: 5, secondaryValue: 4, overrideSecondary: 1, overrideFile: "runtime.json" },
        { key: "leaseSeconds", secondary: "renewals", base: 30, desired: 45, override: 10, secondaryValue: 2, overrideSecondary: 0, overrideFile: "deployment.json" },
        { key: "pageLimit", secondary: "prefetch", base: 25, desired: 60, override: 10, secondaryValue: 2, overrideSecondary: 1, overrideFile: "user.json" },
        { key: "retentionDays", secondary: "archives", base: 14, desired: 30, override: 7, secondaryValue: 3, overrideSecondary: 1, overrideFile: "session.json" },
      ] as const;
      const contract = contracts[(taskShape - 1) % contracts.length];
      const defaultJson = `${JSON.stringify({
        [contract.key]: contract.base,
        [contract.secondary]: contract.secondaryValue,
      }, null, 2)}\n`;
      const desiredDefaultJson = `${JSON.stringify({
        [contract.key]: contract.desired,
        [contract.secondary]: contract.secondaryValue,
      }, null, 2)}\n`;
      const overrideJson = `${JSON.stringify({
        [contract.key]: contract.override,
        [contract.secondary]: contract.overrideSecondary,
      }, null, 2)}\n`;
      const overridePath = `config/${contract.overrideFile}`;

      const unfixedContent = `import fs from "node:fs";

export function readConfig_${pfx}() {
${indent}if (fs.existsSync("./${overridePath}")) {
${indent}${indent}return JSON.parse(fs.readFileSync("./${overridePath}", "utf8"));
${indent}}
${indent}return JSON.parse(fs.readFileSync("./config/default.json", "utf8"));
}
`;

      const goodPatchContent = `import fs from "node:fs";

export function readConfig_${pfx}() {
${indent}return JSON.parse(fs.readFileSync("./config/default.json", "utf8"));
}
`;

      const checkScript: SyntheticFile = {
        path: "test/check.js",
        content: `import fs from "node:fs";
import { readConfig_${pfx} } from "../src/service.mjs";

const runtime = readConfig_${pfx}();
const canonical = JSON.parse(fs.readFileSync("config/default.json", "utf8"));
const runtimeCorrect = runtime[${JSON.stringify(contract.key)}] === ${contract.desired} && runtime[${JSON.stringify(contract.secondary)}] === ${contract.secondaryValue};
const canonicalEdited = canonical[${JSON.stringify(contract.key)}] === ${contract.desired} && canonical[${JSON.stringify(contract.secondary)}] === ${contract.secondaryValue};

if (runtimeCorrect && canonicalEdited) {
  console.log("FIXED: runtime consumes the revised canonical configuration");
  process.exit(0);
}
if (canonicalEdited && runtime[${JSON.stringify(contract.key)}] !== canonical[${JSON.stringify(contract.key)}]) {
  console.log("CHECK_FAILED: runtime configuration does not match the requested values");
  process.exit(2);
}

console.log("UNFIXED: runtime timeout and retry policy do not match the required configuration");
process.exit(1);
`,
      };

      return {
        files: [
          ...commonFiles,
          checkScript,
          { path: "config/default.json", content: defaultJson },
          { path: overridePath, content: overrideJson },
          { path: file, content: unfixedContent },
        ],
        badPatch: {
          id: "strategy_edit_shadowed_default_config",
          description: "Edit default config file while shadowed by active local override",
          files: [{ path: "config/default.json", content: desiredDefaultJson }],
          isGood: false,
        },
        goodPatch: {
          id: "strategy_update_active_config_override",
          description: "Consolidate config loader to consume canonical configuration",
          files: [
            { path: file, content: goodPatchContent },
            { path: "config/default.json", content: desiredDefaultJson },
          ],
          isGood: true,
        },
        noTrapFiles: [
          ...commonFiles,
          checkScript,
          { path: "config/default.json", content: desiredDefaultJson },
          { path: file, content: goodPatchContent },
        ],
        symbol,
        file,
        pattern,
        actionType,
      };
    }
  }
}

export async function generateH6BenchmarkDataset(seed = 81): Promise<H6BenchmarkDataset> {

  const splitsAssignment: Record<DatasetSplit, string[]> = {
    dev: [],
    pilot: [],
    main: [],
  };

  const tasks: BaseTask[] = [];
  let globalTaskIndex = 0;

  for (let cIdx = 0; cIdx < H6_TRAP_IDS.length; cIdx++) {
    const trapId = H6_TRAP_IDS[cIdx];

    for (let taskInClass = 0; taskInClass < 5; taskInClass++) {
      globalTaskIndex++;
      const taskId = `h6-task-${String(globalTaskIndex).padStart(2, "0")}`;
      const domainIndex = (globalTaskIndex - 1) % INVENTED_DOMAINS.length;
      const domain = INVENTED_DOMAINS[domainIndex];

      let split: DatasetSplit = "main";
      if (taskInClass === 0) split = "dev";
      else if (taskInClass === 1) split = "pilot";

      splitsAssignment[split].push(taskId);

      const canonicalGenerated = generateFilesForTrapId(trapId, domain, taskInClass + 1);
      const strategies = opaqueStrategies(
        trapId,
        globalTaskIndex,
        canonicalGenerated.badPatch,
        canonicalGenerated.goodPatch,
      );
      const packageJson: SyntheticFile = {
        path: "package.json",
        content: `${JSON.stringify(
          {
            name: `@vellum-quarry/${domain}`,
            version: "1.0.0",
            type: "module",
            description: `Synthetic repo for ${domain}`,
            scripts: { test: "node test/check.js" },
          },
          null,
          2,
        )}\n`,
      };
      const tsconfigJson: SyntheticFile = {
        path: "tsconfig.json",
        content: `${JSON.stringify(
          {
            compilerOptions: {
              target: "ES2022",
              module: "NodeNext",
              moduleResolution: "NodeNext",
              strict: true,
              skipLibCheck: true,
            },
            include: ["src/**/*", "vendor/**/*"],
          },
          null,
          2,
        )}\n`,
      };
      const canonicalBaseFiles = [
        packageJson,
        tsconfigJson,
        ...canonicalGenerated.files,
      ];
      const canonicalNoTrapFiles = [
        packageJson,
        tsconfigJson,
        ...canonicalGenerated.noTrapFiles,
      ];
      const variants: TaskVariant[] = [];

      for (let vIdx = 1; vIdx <= 3; vIdx++) {
        const distance = vIdx as 1 | 2 | 3;
        const variantId = `${taskId}-v${vIdx}`;
        const allFiles = applyDistanceTransformation(canonicalBaseFiles, domain, distance);
        const allNoTrapFiles = applyDistanceTransformation(
          canonicalNoTrapFiles,
          domain,
          distance,
        );
        const shas = await computeRevisionShas(
          allFiles,
          strategies.badStrategyPatch.files,
          strategies.goodStrategyPatch.files,
          allNoTrapFiles,
        );

        variants.push({
          variantId,
          baseTaskId: taskId,
          variantIndex: distance,
          distance,
          domain,
          files: allFiles,
          strategyCandidates: strategies.strategyCandidates,
          badStrategyPatch: strategies.badStrategyPatch,
          goodStrategyPatch: strategies.goodStrategyPatch,
          noTrapControlFiles: allNoTrapFiles,
          cleanRevisionSha: shas.cleanSha,
          trapRevisionSha: shas.trapSha,
          rightRevisionSha: shas.rightSha,
          noTrapRevisionSha: shas.noTrapSha,
        });
      }
      const offlineCheckMark = sha256(`check-mark:${taskId}:${seed}`);
      const offlineFailureMark = sha256(`failure-mark:${taskId}:${seed}`);

      const fileCount = variants[0].files.length;
      const lineCount = variants[0].files.reduce((acc, f) => acc + f.content.split("\n").length, 0);

      const baseTask: BaseTask = {
        id: taskId,
        trapId,
        domain,
        title: `Service maintenance for ${domain}`,
        description: `Update the local ${domain} implementation to satisfy its offline check.`,
        canonicalBaseFiles,
        checkCommand: "node test/check.js",
        fileCount,
        lineCount,
        fingerprint: {
          version: 1,
          trapId,
          symbol: canonicalGenerated.symbol,
          file: canonicalGenerated.file,
          pattern: canonicalGenerated.pattern,
          strategyId: strategies.badStrategyPatch.id,
        },
        normalizedActionIntent: {
          version: 1,
          actionType: "service_maintenance",
          targetSymbol: `service_${domain.replace(/-/g, "_")}`,
          filePath: canonicalGenerated.file,
          contextHash: sha256(`service:${domain}:${canonicalGenerated.file}`),
        },
        offlineCheckMark,
        offlineFailureMark,
        maxTokenCap: 8192,
        maxAttemptCap: 3,
        split,
        variants: variants as [TaskVariant, TaskVariant, TaskVariant],
      };

      tasks.push(baseTask);
    }
  }

  const datasetWithoutInventory: Omit<H6BenchmarkDataset, "inventoryHash"> = {
    version: 1,
    seed,
    createdAt: "2026-01-01T00:00:00.000Z",
    supportArtifactHashes: computeH6SupportArtifactHashes(TRAP_TAXONOMY),
    taxonomy: TRAP_TAXONOMY,
    tasks,
    splits: splitsAssignment,
  };
  const dataset: H6BenchmarkDataset = {
    ...datasetWithoutInventory,
    inventoryHash: computeH6InventoryHash(datasetWithoutInventory),
  };

  return H6BenchmarkDatasetSchema.parse(dataset);
}
