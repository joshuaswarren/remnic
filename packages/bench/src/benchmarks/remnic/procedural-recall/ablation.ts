/**
 * Procedural recall ablation harness (issue #567 PR 1/5).
 *
 * Runs the same fixture twice — once with `procedural.enabled=false`, once
 * with `procedural.enabled=true` — and emits a diff artifact:
 *
 *   { onScore, offScore, lift, confidenceInterval }
 *
 * The harness is deterministic and uses no LLM calls: the "stub LLM adapter"
 * requirement is satisfied because the scoring function is a pure, local
 * check (`buildProcedureRecallSection` returns markdown when gating + token
 * overlap thresholds pass). Downstream slices (PR 2) plug in a stub response
 * adapter via `StubLlmAdapter` for scenarios that need free-form generation.
 *
 * CLI: `remnic bench procedural-ablation --fixture <path> --out <path>`
 */
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  StorageManager,
  parseConfig,
  buildProcedureRecallSection,
  buildProcedureMarkdownBody,
} from "@remnic/core";
import { composeMemoryEnvelope } from "@remnic/core/write-envelope";
import { pairedDeltaConfidenceInterval } from "../../../stats/bootstrap.js";
import type { ConfidenceInterval } from "../../../types.js";
import {
  PROCEDURAL_RECALL_E2E_FIXTURE,
  type ProceduralRecallE2eCase,
} from "./fixture.js";

/**
 * Scenario shape for the ablation harness. A superset of
 * `ProceduralRecallE2eCase` with an `expectMatch` alias so downstream fixtures
 * can be expressed in either vocabulary.
 */
export interface ProceduralAblationScenario {
  id: string;
  prompt: string;
  procedurePreamble: string;
  procedureSteps: Array<{ order: number; intent: string }>;
  procedureTags: string[];
  /**
   * True when the prompt should recall the procedure. False for distractor /
   * non-task-initiation prompts where we expect the gate to reject.
   */
  expectMatch: boolean;
}

export interface ProceduralAblationPerCase {
  id: string;
  prompt: string;
  expectMatch: boolean;
  onMatched: boolean;
  offMatched: boolean;
  onScore: number;
  offScore: number;
}

export interface ProceduralAblationArtifact {
  schemaVersion: 1;
  fixture: {
    path: string | null;
    scenarioCount: number;
  };
  onScore: number;
  offScore: number;
  lift: number;
  confidenceInterval: ConfidenceInterval;
  perCase: ProceduralAblationPerCase[];
  generatedAt: string;
}

/**
 * Score a single scenario: 1 if the observed recall matches expectation, else 0.
 * This is a binary correctness metric, so `lift = onScore - offScore` is
 * directly interpretable as points of accuracy gained by turning procedural
 * recall on.
 */
function scoreCase(expectMatch: boolean, observedMatch: boolean): number {
  return observedMatch === expectMatch ? 1 : 0;
}

/**
 * Convert the existing `ProceduralRecallE2eCase` fixture into
 * ablation-scenario shape. The ablation ALWAYS sweeps procedural on and off,
 * so `expectMatch` must reflect what the prompt + procedure pair should do
 * WHEN PROCEDURAL IS ON — not what the original row's `proceduralEnabled`
 * flag produced.
 *
 * Gate-control rows in the e2e fixture (where `proceduralEnabled=false`
 * produces `expectNonNullSection=false` only because of the gate, not the
 * content) are excluded here: their ON-side outcome is content-dependent and
 * not something this mapper can label correctly without re-running
 * `buildProcedureRecallSection`. Callers that need those rows should write
 * the scenario directly with an explicit `expectMatch`.
 */
export function fixtureToAblationScenarios(
  fixture: ProceduralRecallE2eCase[],
): ProceduralAblationScenario[] {
  const scenarios: ProceduralAblationScenario[] = [];
  for (const c of fixture) {
    // Skip rows whose `expectNonNullSection` only expresses gate-off
    // behavior — we cannot derive ON-side ground truth from them.
    if (c.proceduralEnabled === false) continue;
    scenarios.push({
      id: c.id,
      prompt: c.prompt,
      procedurePreamble: c.procedurePreamble,
      procedureSteps: c.procedureSteps,
      procedureTags: c.procedureTags,
      // `proceduralEnabled` was true (or undefined), so
      // `expectNonNullSection` reflects the ON-side ground truth.
      expectMatch: c.expectNonNullSection === true,
    });
  }
  return scenarios;
}

/**
 * Run one side of the ablation: seed a temp store with each scenario's
 * procedure, then invoke `buildProcedureRecallSection` with the requested
 * gating and observe whether a non-null section was returned.
 */
async function runSide(
  scenarios: ProceduralAblationScenario[],
  proceduralEnabled: boolean,
): Promise<boolean[]> {
  const observed: boolean[] = [];
  for (const scenario of scenarios) {
    const dir = await mkdtemp(
      path.join(os.tmpdir(), "remnic-bench-proc-ablation-"),
    );
    try {
      const storage = new StorageManager(dir);
      await storage.ensureDirectories();
      const body = buildProcedureMarkdownBody(scenario.procedureSteps);
      // Sealed-envelope write (issue #1989 PR4): bench-built corpus.
      await storage.writeSealedMemory(
        composeMemoryEnvelope(
          {
            content: `${scenario.procedurePreamble}\n\n${body}`,
            category: "procedure",
            tags: scenario.procedureTags,
          },
          { source: "bench" },
        ),
        {},
      );

      const config = parseConfig({
        memoryDir: dir,
        workspaceDir: path.join(dir, "ws"),
        openaiApiKey: "bench-key",
        procedural: {
          enabled: proceduralEnabled,
          recallMaxProcedures: 3,
        },
      });

      const section = await buildProcedureRecallSection(
        storage,
        scenario.prompt,
        config,
      );
      observed.push(section !== null && section.length > 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return observed;
}

/**
 * Default bootstrap seed used when no `random` / `seed` override is supplied.
 * Fixing this makes CI bounds reproducible across CLI invocations — flaky CI
 * bounds would break artifact-based comparisons and saved baselines.
 */
export const DEFAULT_ABLATION_BOOTSTRAP_SEED = 0x72656d6e; // ASCII "remn"

/**
 * Mulberry32 seeded RNG. Inlined (and re-used from tests) so callers can get a
 * deterministic default without needing an external dependency.
 */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RunProceduralAblationOptions {
  scenarios: ProceduralAblationScenario[];
  /** Path the ablation was loaded from (echoed back into the artifact). */
  fixturePath?: string | null;
  /** Bootstrap iterations for CI on the paired delta (default: 1_000). */
  bootstrapIterations?: number;
  /**
   * Seeded RNG for the bootstrap. Defaults to
   * `createSeededRandom(DEFAULT_ABLATION_BOOTSTRAP_SEED)` so CI bounds are
   * deterministic across repeated CLI invocations. Pass `Math.random`
   * explicitly to opt into non-deterministic sampling.
   */
  random?: () => number;
  /**
   * Convenience alternative to `random`: if provided (and `random` is not),
   * a seeded mulberry32 RNG is built from this integer.
   */
  seed?: number;
}

/**
 * Pure entrypoint — accepts a scenario list and returns the artifact. Reads
 * and writes are isolated to the StorageManager temp directories the sides
 * create and remove internally.
 */
export async function runProceduralAblation(
  options: RunProceduralAblationOptions,
): Promise<ProceduralAblationArtifact> {
  const { scenarios } = options;
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    throw new Error(
      "runProceduralAblation requires a non-empty scenarios array",
    );
  }

  const onMatched = await runSide(scenarios, true);
  const offMatched = await runSide(scenarios, false);

  const onPer = scenarios.map((s, i) => scoreCase(s.expectMatch, onMatched[i]!));
  const offPer = scenarios.map((s, i) =>
    scoreCase(s.expectMatch, offMatched[i]!),
  );

  const onScore =
    onPer.reduce((sum, value) => sum + value, 0) / onPer.length;
  const offScore =
    offPer.reduce((sum, value) => sum + value, 0) / offPer.length;
  const lift = onScore - offScore;

  const rng =
    options.random ??
    (typeof options.seed === "number"
      ? createSeededRandom(options.seed)
      : createSeededRandom(DEFAULT_ABLATION_BOOTSTRAP_SEED));
  const confidenceInterval = pairedDeltaConfidenceInterval(onPer, offPer, {
    iterations: options.bootstrapIterations ?? 1_000,
    random: rng,
  });

  const perCase: ProceduralAblationPerCase[] = scenarios.map((s, i) => ({
    id: s.id,
    prompt: s.prompt,
    expectMatch: s.expectMatch,
    onMatched: onMatched[i]!,
    offMatched: offMatched[i]!,
    onScore: onPer[i]!,
    offScore: offPer[i]!,
  }));

  return {
    schemaVersion: 1,
    fixture: {
      path: options.fixturePath ?? null,
      scenarioCount: scenarios.length,
    },
    onScore,
    offScore,
    lift,
    confidenceInterval,
    perCase,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Load a scenario list from a JSON file. Validates the JSON is an object with
 * a `scenarios` array (or a bare array) and each entry has the required
 * fields. Rejects invalid input per CLAUDE.md rule 51 rather than silently
 * defaulting.
 */
export async function loadAblationFixture(
  fixturePath: string,
): Promise<ProceduralAblationScenario[]> {
  const raw = await readFile(fixturePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse fixture JSON at ${fixturePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`Fixture at ${fixturePath} must be a JSON object or array`);
  }
  const scenariosRaw = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { scenarios?: unknown }).scenarios)
      ? (parsed as { scenarios: unknown[] }).scenarios
      : null;
  if (!Array.isArray(scenariosRaw)) {
    throw new Error(
      `Fixture at ${fixturePath} must contain a \"scenarios\" array or be an array at the top level`,
    );
  }

  const scenarios: ProceduralAblationScenario[] = [];
  for (let i = 0; i < scenariosRaw.length; i++) {
    const row = scenariosRaw[i];
    if (!row || typeof row !== "object") {
      throw new Error(`Fixture scenario at index ${i} must be an object`);
    }
    const r = row as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : null;
    const prompt = typeof r.prompt === "string" ? r.prompt : null;
    const preamble =
      typeof r.procedurePreamble === "string" ? r.procedurePreamble : null;
    const steps = Array.isArray(r.procedureSteps) ? r.procedureSteps : null;
    let tags: string[] | null = null;
    if (Array.isArray(r.procedureTags)) {
      const raw = r.procedureTags as unknown[];
      for (let k = 0; k < raw.length; k++) {
        if (typeof raw[k] !== "string") {
          throw new Error(
            `Fixture scenario at index ${i}: procedureTags[${k}] must be a string (got ${typeof raw[k]})`,
          );
        }
      }
      tags = raw as string[];
    }
    const expect = typeof r.expectMatch === "boolean" ? r.expectMatch : null;
    if (
      id === null ||
      prompt === null ||
      preamble === null ||
      steps === null ||
      tags === null ||
      expect === null
    ) {
      throw new Error(
        `Fixture scenario at index ${i} is missing one of: id, prompt, procedurePreamble, procedureSteps, procedureTags, expectMatch`,
      );
    }
    const normalizedSteps: Array<{ order: number; intent: string }> = [];
    for (let j = 0; j < steps.length; j++) {
      const s = steps[j];
      if (!s || typeof s !== "object") {
        throw new Error(
          `Fixture scenario ${id} step ${j} must be an object with order and intent`,
        );
      }
      const obj = s as Record<string, unknown>;
      // Reject non-integer / non-positive `order` values explicitly instead
      // of coercing via Math.floor or defaulting to positional index. Step
      // order is load-bearing for serialized procedure bodies; a silently
      // rounded 1.7 → 1 changes both the written markdown and the recall
      // scoring text.
      let order: number;
      if (obj.order === undefined) {
        order = j + 1;
      } else if (
        typeof obj.order !== "number" ||
        !Number.isFinite(obj.order) ||
        !Number.isInteger(obj.order) ||
        obj.order < 1
      ) {
        throw new Error(
          `Fixture scenario ${id} step ${j}: order must be a positive integer (got ${JSON.stringify(
            obj.order,
          )})`,
        );
      } else {
        order = obj.order;
      }
      const intent = typeof obj.intent === "string" ? obj.intent : null;
      if (intent === null) {
        throw new Error(
          `Fixture scenario ${id} step ${j} is missing string \"intent\"`,
        );
      }
      normalizedSteps.push({ order, intent });
    }
    scenarios.push({
      id,
      prompt,
      procedurePreamble: preamble,
      procedureSteps: normalizedSteps,
      procedureTags: tags,
      expectMatch: expect,
    });
  }
  return scenarios;
}

/**
 * CLI entrypoint. Resolves `--fixture <path>` (defaults to the built-in e2e
 * fixture converted to ablation scenarios when unset) and writes the artifact
 * to `--out <path>`. Validates inputs per CLAUDE.md rules 14 / 17 / 51.
 */
export interface RunProceduralAblationCliArgs {
  fixturePath: string | null;
  outPath: string;
  bootstrapIterations?: number;
  random?: () => number;
  /**
   * Optional seed for the bootstrap RNG. When omitted the harness uses
   * `DEFAULT_ABLATION_BOOTSTRAP_SEED` so CLI runs are reproducible by
   * default.
   */
  seed?: number;
}

export async function runProceduralAblationCli(
  args: RunProceduralAblationCliArgs,
): Promise<ProceduralAblationArtifact> {
  const scenarios =
    args.fixturePath !== null
      ? await loadAblationFixture(args.fixturePath)
      : fixtureToAblationScenarios(PROCEDURAL_RECALL_E2E_FIXTURE);

  const artifact = await runProceduralAblation({
    scenarios,
    fixturePath: args.fixturePath,
    bootstrapIterations: args.bootstrapIterations,
    random: args.random,
    seed: args.seed,
  });

  const outDir = path.dirname(path.resolve(args.outPath));
  await mkdir(outDir, { recursive: true });
  await writeFile(args.outPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  return artifact;
}
