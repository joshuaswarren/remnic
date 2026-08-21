/**
 * Sealed LLM-judge rubric loader, invocation, and score parser for the
 * Assistant bench tier.
 *
 * Sealing contract:
 *   1. The rubric prompt lives in the in-process registry
 *      (`sealed-prompts/index.ts`) and is never exposed to the
 *      system-under-test.
 *   2. The rubric text's SHA-256 digest is embedded into every run result so
 *      any change to the prompt is detectable by consumers of the bench feed.
 *   3. Rotations are additive — add a new registry entry and a matching
 *      `.md` mirror, do not edit old ones.
 */

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_ASSISTANT_RUBRIC_ID,
  SEALED_PROMPT_REGISTRY,
} from "./sealed-prompts/index.js";

export const ASSISTANT_RUBRIC_DIMENSIONS = [
  "identity_accuracy",
  "stance_coherence",
  "novelty",
  "calibration",
] as const;

export type AssistantRubricDimension =
  (typeof ASSISTANT_RUBRIC_DIMENSIONS)[number];

export type AssistantRubricScores = Record<AssistantRubricDimension, number>;

export interface SealedRubric {
  id: string;
  version: string;
  prompt: string;
  sha256: string;
}

export interface SealedJudgeInput {
  taskId: string;
  scenario: string;
  memorySummary: string;
  assistantOutput: string;
}

export interface SealedJudgeDecision {
  taskId: string;
  rubricId: string;
  rubricSha256: string;
  scores: AssistantRubricScores;
  notes: string;
  rawResponse: string;
  parseOk: boolean;
}

/**
 * Rich structured-judge contract for the Assistant tier. Unlike
 * `BenchJudge.score()`, which returns a scalar, structured judges return the
 * raw JSON response text so we can parse the full multi-dimension rubric.
 */
export interface StructuredJudge {
  evaluate(request: {
    system: string;
    user: string;
    rubricId: string;
    taskId: string;
  }): Promise<string>;
}

export interface SpotCheckLogger {
  log(decision: SealedJudgeDecision, context: SealedJudgeInput): void;
}

/**
 * Load a sealed rubric prompt from the in-process registry by id.
 *
 * The returned object captures the canonical text and a SHA-256 digest which
 * callers are expected to store in benchmark results so reviewers can verify
 * the exact rubric text used for a given run.
 */
export function loadSealedRubric(
  id: string = DEFAULT_ASSISTANT_RUBRIC_ID,
  options: { registry?: Readonly<Record<string, string>> } = {},
): SealedRubric {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(
      `sealed rubric id must match [a-z0-9][a-z0-9-]*, received "${id}"`,
    );
  }

  const registry = options.registry ?? SEALED_PROMPT_REGISTRY;
  const prompt = registry[id];
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new Error(`sealed rubric not found in registry: ${id}`);
  }

  const sha256 = createHash("sha256").update(prompt, "utf8").digest("hex");
  const version = parseVersionFromId(id);

  return { id, version, prompt, sha256 };
}

/**
 * Verify that a registered rubric still matches an expected digest. Useful in
 * tests and in CI gates that want to catch accidental edits to sealed text.
 */
export function verifyRubricDigest(
  expectedSha256: string,
  options: { id?: string; registry?: Readonly<Record<string, string>> } = {},
): boolean {
  const rubric = loadSealedRubric(options.id, { registry: options.registry });
  return rubric.sha256 === expectedSha256;
}

/**
 * Build the judge message payload for a single task. Keeps the rubric prompt
 * on the system side of the conversation and the task-specific substitutions
 * in a user message so the judge never leaks rubric text back into the SUT
 * path.
 */
export function buildJudgePayload(
  rubric: SealedRubric,
  input: SealedJudgeInput,
): { system: string; user: string } {
  const user = [
    `TASK_ID: ${input.taskId}`,
    "",
    "SCENARIO:",
    input.scenario,
    "",
    "MEMORY_GRAPH_SUMMARY:",
    input.memorySummary,
    "",
    "ASSISTANT_OUTPUT:",
    input.assistantOutput,
    "",
    "Respond with a JSON object following the rubric output format.",
  ].join("\n");

  return { system: rubric.prompt, user };
}

/**
 * Invoke a structured judge with the sealed rubric and parse the response.
 *
 * When `judge` is `undefined` we return a parse_error decision with all-zero
 * scores so the caller can still complete the benchmark with a visible signal
 * that the judge was missing.
 */
export async function runSealedJudge(
  judge: StructuredJudge | undefined,
  rubric: SealedRubric,
  input: SealedJudgeInput,
  options: { spotCheckLogger?: SpotCheckLogger } = {},
): Promise<SealedJudgeDecision> {
  const payload = buildJudgePayload(rubric, input);
  let decision: SealedJudgeDecision;

  if (!judge) {
    decision = {
      taskId: input.taskId,
      rubricId: rubric.id,
      rubricSha256: rubric.sha256,
      scores: zeroScores(),
      notes: "parse_error: no judge provider wired",
      rawResponse: "",
      parseOk: false,
    };
  } else {
    let rawResponse = "";
    try {
      rawResponse = await judge.evaluate({
        system: payload.system,
        user: payload.user,
        rubricId: rubric.id,
        taskId: input.taskId,
      });
    } catch (error) {
      decision = {
        taskId: input.taskId,
        rubricId: rubric.id,
        rubricSha256: rubric.sha256,
        scores: zeroScores(),
        notes: `parse_error: judge threw (${
          error instanceof Error ? error.message : String(error)
        })`,
        rawResponse: "",
        parseOk: false,
      };
      options.spotCheckLogger?.log(decision, input);
      return decision;
    }

    const parsed = parseRubricResponse(rawResponse);
    decision = {
      taskId: input.taskId,
      rubricId: rubric.id,
      rubricSha256: rubric.sha256,
      scores: parsed.scores,
      notes: parsed.notes,
      rawResponse,
      parseOk: parsed.ok,
    };
  }

  options.spotCheckLogger?.log(decision, input);
  return decision;
}

/**
 * Parse a judge response string as rubric JSON. Exported for unit tests and
 * for judge adapters that return the raw response directly.
 */
export function parseRubricResponse(raw: string): {
  scores: AssistantRubricScores;
  notes: string;
  ok: boolean;
} {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { scores: zeroScores(), notes: "parse_error: empty", ok: false };
  }

  const jsonCandidate = extractJsonObject(trimmed);
  if (jsonCandidate === null) {
    return {
      scores: zeroScores(),
      notes: "parse_error: no JSON object",
      ok: false,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch {
    return {
      scores: zeroScores(),
      notes: "parse_error: invalid JSON",
      ok: false,
    };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return {
      scores: zeroScores(),
      notes: "parse_error: not an object",
      ok: false,
    };
  }

  const scoreObject = unwrapScoreObject(parsed as Record<string, unknown>);
  const scores = zeroScores();
  for (const dimension of ASSISTANT_RUBRIC_DIMENSIONS) {
    const value = coerceScoreValue(scoreObject[dimension]);
    if (value === undefined) {
      return {
        scores: zeroScores(),
        notes: `parse_error: missing dimension ${dimension}`,
        ok: false,
      };
    }
    scores[dimension] = clampScore(value);
  }

  const rawNotes = scoreObject.notes;
  const notes = typeof rawNotes === "string" ? rawNotes : "";
  return { scores, notes, ok: true };
}

function unwrapScoreObject(
  parsed: Record<string, unknown>,
): Record<string, unknown> {
  if (hasValidCompleteRubricDimensions(parsed)) {
    return parsed;
  }

  const nested = parsed.scores;
  if (
    nested &&
    typeof nested === "object" &&
    !Array.isArray(nested)
  ) {
    return {
      ...(nested as Record<string, unknown>),
      ...(typeof parsed.notes === "string" ? { notes: parsed.notes } : {}),
    };
  }

  return parsed;
}

function hasValidCompleteRubricDimensions(value: Record<string, unknown>): boolean {
  return ASSISTANT_RUBRIC_DIMENSIONS.every(
    (dimension) => coerceScoreValue(value[dimension]) !== undefined,
  );
}

function coerceScoreValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

/**
 * Spot-check logger that appends selected judge decisions to a JSONL file.
 * The caller controls the `runId` to keep logs grouped per-run.
 *
 * Logging is a diagnostic side effect, so any filesystem error (non-writable
 * directory, path conflict with an existing file, mid-run ENOSPC, etc.) is
 * caught and downgraded to a one-time `console.warn` rather than aborting
 * the benchmark run. We also fail-safe the `mkdirSync` at construction
 * time: if the directory cannot be created, we return a no-op logger so
 * callers can still run the benchmark end-to-end.
 */
export function createSpotCheckFileLogger(options: {
  runId: string;
  directory: string;
  sampleRate?: number;
  random?: () => number;
  sampleSize?: number;
}): SpotCheckLogger {
  const {
    runId,
    directory,
    sampleRate,
    sampleSize,
    random = Math.random,
  } = options;

  if (!runId || !/^[a-z0-9][a-z0-9_.-]*$/i.test(runId)) {
    throw new Error(
      `spot-check runId must be non-empty and match [a-z0-9][a-z0-9_.-]*`,
    );
  }

  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    console.warn(
      `[sealed-rubric] spot-check logger disabled: could not create directory ${directory}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { log() {} };
  }

  const logPath = path.join(directory, `${runId}.jsonl`);
  let written = 0;
  let warnedOnWriteFailure = false;
  const cap = typeof sampleSize === "number" && sampleSize > 0 ? sampleSize : 5;
  const rate = typeof sampleRate === "number" ? sampleRate : 0.25;

  return {
    log(decision, context) {
      if (written >= cap) return;
      if (random() > rate) return;

      const entry = {
        ts: new Date().toISOString(),
        runId,
        taskId: decision.taskId,
        rubricId: decision.rubricId,
        rubricSha256: decision.rubricSha256,
        scores: decision.scores,
        notes: decision.notes,
        parseOk: decision.parseOk,
        scenarioPreview: truncate(context.scenario, 240),
        outputPreview: truncate(context.assistantOutput, 240),
      };
      try {
        appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
        written += 1;
      } catch (error) {
        if (!warnedOnWriteFailure) {
          console.warn(
            `[sealed-rubric] spot-check write failed for ${logPath}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          warnedOnWriteFailure = true;
        }
      }
    },
  };
}

/**
 * Create a deterministic spot-check logger useful in tests: always picks the
 * first `sampleSize` decisions regardless of random draw.
 */
export function createDeterministicSpotCheckLogger(options: {
  runId: string;
  directory: string;
  sampleSize?: number;
}): SpotCheckLogger {
  return createSpotCheckFileLogger({
    runId: options.runId,
    directory: options.directory,
    sampleRate: 1,
    sampleSize: options.sampleSize ?? 5,
    random: () => 0,
  });
}

export function zeroScores(): AssistantRubricScores {
  return {
    identity_accuracy: 0,
    stance_coherence: 0,
    novelty: 0,
    calibration: 0,
  };
}

export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 5) return 5;
  return Math.round(value * 100) / 100;
}

function parseVersionFromId(id: string): string {
  const match = id.match(/-v(\d+)$/);
  return match ? `v${match[1]}` : "v0";
}

function extractJsonObject(raw: string): string | null {
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  return raw.slice(first, last + 1);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}
