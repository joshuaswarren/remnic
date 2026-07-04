/**
 * Local-lab runtime profile manifest (issue #1573 PR2).
 *
 * A `local-lab` profile is a JSON manifest — never hardcoded model strings
 * (rule 30/55) — that pins a single-locale bench run (responder, judge,
 * optional embedding) to operator-hosted models. It is resolved by
 * `resolveBenchRuntimeProfile` to drive sequential phase scheduling and
 * endpoint preflight (see `preflight.ts` and `sequential-phases.ts`).
 *
 * Field contract:
 *
 *   - `provider` is one of `LOCAL_LAB_PROVIDER_KINDS` ("openai-compatible"
 *     for llama.cpp / vLLM / LM Studio; "ollama" for native Ollama). Any
 *     other value is REJECTED with the valid kinds listed (rule 51 — never
 *     silently fall through to a default).
 *   - `temperature` is pinned to 0 and `seed` is required so local-lab
 *     runs are reproducible.
 *   - `ctx` is the manifest-declared serving context (tokens). Preflight
 *     verifies the live endpoint reports at least this much.
 *
 * The manifest is content (no command strings interpolated into shells;
 * rule 10) — `baseUrl`/`model` are only ever fetch targets.
 */

import { readFile } from "node:fs/promises";

/**
 * Provider kinds accepted by a local-lab manifest role.
 *
 * `"openai-compatible"` maps to the OpenAI-compatible transport
 * (`/v1/chat/completions` + `/v1/models`) used by llama.cpp, vLLM, LM
 * Studio, etc. `"ollama"` maps to Ollama's native transport
 * (`/api/generate` + `/api/tags`).
 */
export const LOCAL_LAB_PROVIDER_KINDS = [
  "openai-compatible",
  "ollama",
] as const;
export type LocalLabProviderKind = (typeof LOCAL_LAB_PROVIDER_KINDS)[number];

export interface LocalLabRoleConfig {
  provider: LocalLabProviderKind;
  /** Base URL of the operator-hosted endpoint (e.g. `http://localhost:1234/v1`). */
  baseUrl: string;
  /** Exact model id the endpoint reports (no aliases, no shell interpolation). */
  model: string;
  /** Optional quantization label (informational; recorded in artifacts). */
  quantization?: string;
  /** Manifest-declared serving context length in tokens. */
  ctx: number;
  /** Sampling temperature. Local-lab pins this to 0 for reproducibility. */
  temperature: 0;
  /** Sampling seed; required so reruns reproduce the same draws. */
  seed: number;
}

export interface LocalLabManifestNotes {
  /**
   * Free-form operator guidance printed between responder and judge phases
   * when the two roles live on different endpoints. When both roles share
   * an endpoint the runner skips the hand-off (see sequential-phases.ts).
   */
  responderToJudgeHandoff?: string;
  [key: string]: unknown;
}

export interface LocalLabManifest {
  /** Manifest discriminator; always the literal `"local-lab"`. */
  profile: "local-lab";
  responder: LocalLabRoleConfig;
  judge: LocalLabRoleConfig;
  embedding?: LocalLabRoleConfig;
  /** Phase scheduling mode. PR2 ships `"sequential"` only. */
  phases: "sequential";
  notes?: LocalLabManifestNotes;
}

/**
 * Parse and validate a local-lab manifest from an unknown parsed JSON value.
 * Throws a rule-51-shaped error (lists valid kinds) on any violation.
 */
export function parseLocalLabManifest(raw: unknown): LocalLabManifest {
  if (!isPlainObject(raw)) {
    throw new Error(
      "local-lab manifest must be a JSON object (rule 18: parsed JSON must be object-not-null)",
    );
  }

  if (raw.profile !== "local-lab") {
    throw new Error(
      `local-lab manifest requires profile === "local-lab"; received ${describeValue(raw.profile)}`,
    );
  }

  if (raw.phases !== "sequential") {
    throw new Error(
      `local-lab manifest phases must be "sequential" in PR2; received ${describeValue(raw.phases)}`,
    );
  }

  const responder = parseRole(raw.responder, "responder");
  const judge = parseRole(raw.judge, "judge");
  const embedding =
    raw.embedding === undefined ? undefined : parseRole(raw.embedding, "embedding");

  const notes =
    raw.notes === undefined ? undefined : parseNotes(raw.notes, "notes");

  return {
    profile: "local-lab",
    responder,
    judge,
    ...(embedding ? { embedding } : {}),
    phases: "sequential",
    ...(notes ? { notes } : {}),
  };
}

/**
 * Read and parse a local-lab manifest from disk. The path is opened read-only;
 * nothing in the manifest is ever interpolated into a shell (rule 10).
 */
export async function loadLocalLabManifest(
  filePath: string,
): Promise<LocalLabManifest> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    // Do not echo raw error.message — Node read errors embed the absolute
    // path and system diagnostics. Use the errno code (ENOENT, EACCES, …)
    // which is stable and free of path leakage (cursor review, #1573 PR2).
    const code = (error as NodeJS.ErrnoException)?.code ?? "EUNKNOWN";
    throw new Error(`local-lab manifest at ${filePath} could not be read (${code})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // JSON.parse errors carry a position hint but no file-system paths.
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`local-lab manifest at ${filePath} contains invalid JSON: ${detail}`);
  }

  return parseLocalLabManifest(parsed);
}

function parseRole(value: unknown, label: string): LocalLabRoleConfig {
  if (!isPlainObject(value)) {
    throw new Error(
      `local-lab manifest ${label} must be an object; received ${describeValue(value)}`,
    );
  }

  const provider = parseProviderKind(value.provider, label);
  const baseUrl = parseNonEmptyString(value.baseUrl, label, "baseUrl");
  const model = parseNonEmptyString(value.model, label, "model");
  const ctx = parsePositiveInteger(value.ctx, label, "ctx");
  const seed = parseInteger(value.seed, label, "seed");

  // `temperature` must be exactly the number 0 — local-lab reproducibility
  // contract. Anything else (string "0", null, missing, non-zero) is rejected
  // rather than silently coerced (rule 39).
  if (value.temperature !== 0) {
    throw new Error(
      `local-lab manifest ${label}.temperature must be the number 0; received ${describeValue(value.temperature)}`,
    );
  }

  const quantization =
    value.quantization === undefined
      ? undefined
      : parseNonEmptyString(value.quantization, label, "quantization");

  return {
    provider,
    baseUrl,
    model,
    ctx,
    temperature: 0,
    seed,
    ...(quantization ? { quantization } : {}),
  };
}

function parseProviderKind(value: unknown, label: string): LocalLabProviderKind {
  for (const kind of LOCAL_LAB_PROVIDER_KINDS) {
    if (value === kind) {
      return kind;
    }
  }
  // Rule 51: reject invalid enum values with the valid options listed.
  throw new Error(
    `local-lab manifest ${label}.provider must be one of [${LOCAL_LAB_PROVIDER_KINDS.join(
      ", ",
    )}]; received ${describeValue(value)}`,
  );
}

function parseNonEmptyString(
  value: unknown,
  label: string,
  field: string,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `local-lab manifest ${label}.${field} must be a non-empty string; received ${describeValue(value)}`,
    );
  }
  return value.trim();
}

function parsePositiveInteger(value: unknown, label: string, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      `local-lab manifest ${label}.${field} must be a positive integer; received ${describeValue(value)}`,
    );
  }
  return value;
}

function parseInteger(value: unknown, label: string, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(
      `local-lab manifest ${label}.${field} must be an integer; received ${describeValue(value)}`,
    );
  }
  return value;
}

function parseNotes(value: unknown, label: string): LocalLabManifestNotes {
  if (!isPlainObject(value)) {
    throw new Error(
      `local-lab manifest ${label} must be an object; received ${describeValue(value)}`,
    );
  }
  const notes: LocalLabManifestNotes = {};
  for (const [key, entry] of Object.entries(value)) {
    notes[key] = entry;
  }
  return notes;
}

function describeValue(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
