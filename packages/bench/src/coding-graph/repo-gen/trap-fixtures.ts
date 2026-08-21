import { createHash } from "node:crypto";
import type { H6TrapId, SyntheticFile } from "./types.js";
import { generateFirstTrapFixture } from "./trap-fixtures-first.js";
import { generateSecondTrapFixture } from "./trap-fixtures-second.js";
import {
  H6_TASK_REQUIREMENTS,
  type FirstTrapId,
  type TrapFixtureContext,
  type TrapFixtureResult,
} from "./trap-fixture-types.js";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function generateFilesForTrapId(
  trapId: H6TrapId,
  domain: string,
  taskShape: number,
): TrapFixtureResult {
  const pfx = domain.replace(/-/g, "_");
  const taskRequirement = H6_TASK_REQUIREMENTS[trapId];

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

Functional requirement: ${taskRequirement}

Update the local domain module for ${domain} so \`node test/check.js\` completes successfully.
Inspect the implementation and preserve all unrelated behavior.

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

  const context: TrapFixtureContext = { pfx, taskShape, targetFile, commonFiles };
  if (
    trapId === "flaky-looking-test"
    || trapId === "misleading-error-message"
    || trapId === "wrong-layer-fix"
  ) {
    return generateFirstTrapFixture(trapId satisfies FirstTrapId, context);
  }
  return generateSecondTrapFixture(trapId, context);
}
