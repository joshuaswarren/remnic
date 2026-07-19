/**
 * Orchestrator-lite test fixtures for the lifecycle scenario-matrix harness
 * (issue #1993). These helpers are lifted in spirit from the entity-hardening
 * characterization suite (tests/orchestrator-characterization.test.ts) so the
 * matrix rows exercise the REAL orchestrator paths — offline-safe config, temp
 * memoryDir, field-level extraction stub (never a production hook), and the
 * on-disk assertion helpers — rather than reinventing (or mocking) them.
 *
 * Test-support only (lives under src/testing/, never bundled, never exported).
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseConfig } from "../config.js";
import type { Orchestrator } from "../orchestrator.js";
import type { BufferTurn, ExtractionResult, PluginConfig } from "../types.js";

/**
 * Offline-safe config: QMD off, embedding fallback off, planner off (so the
 * deterministic filesystem recall scan runs), extraction thresholds floored so
 * single short turns are extractable, consolidation pushed far out, and the
 * init gate floored so a recall() that never ran initialize() does not block.
 * Mirrors tests/orchestrator-characterization.test.ts:makeConfig.
 */
export function makeLifecycleConfig(
  memoryDir: string,
  overrides: Record<string, unknown> = {},
): PluginConfig {
  return parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    recallPlannerEnabled: false,
    sharedContextEnabled: false,
    triggerMode: "smart",
    bufferMaxTurns: 10,
    extractionMinChars: 0,
    extractionMinUserTurns: 1,
    consolidateEveryN: 50,
    initGateTimeoutMs: 1000,
    ...overrides,
  });
}

/** Create a fresh temp memory dir with a stable `remnic-lifecycle-<label>-` prefix. */
export function mkTempMemoryDir(label: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `remnic-lifecycle-${label}-`));
}

/** One hour in the past — never the same millisecond as any `now` bound (readRecent uses `ts < now`). */
export function pastIso(): string {
  return new Date(Date.now() - 3600_000).toISOString();
}

/** Linear async sleep (shared by the retrying cleanup and pollers). */
export function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * Remove a temp memory dir, retrying transient ENOTEMPTY/EBUSY races: the
 * orchestrator keeps best-effort background writers that can still be running
 * while rm runs. Mirrors the characterization suite's cleanupDir.
 */
export async function cleanupDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EBUSY") throw err;
      await sleep(100);
    }
  }
  await rm(dir, { recursive: true, force: true });
}

/** The field-level extraction seam replaced by {@link stubExtraction}. */
interface ExtractionClientSeam {
  extraction: { extract: (turns: BufferTurn[]) => Promise<ExtractionResult> };
}

/**
 * Stub the LLM extraction client at the orchestrator FIELD level (the
 * established seam — never a production hook). Records every turn slice the
 * engine is asked to extract; storage/persist stays fully real.
 */
export function stubExtraction(
  orchestrator: Orchestrator,
  factory: (turns: BufferTurn[], call: number) => ExtractionResult | Promise<ExtractionResult>,
): BufferTurn[][] {
  const calls: BufferTurn[][] = [];
  // The `extraction` field is private and structurally unexpressible from
  // outside the class; the recorder replaces it in place. Named cast per rule.
  const seam = orchestrator as unknown as ExtractionClientSeam;
  seam.extraction = {
    extract: async (turns: BufferTurn[]) => {
      calls.push(turns);
      return factory(turns, calls.length);
    },
  };
  return calls;
}

/** A single-fact extraction result. */
export function singleFactResult(content: string): ExtractionResult {
  return {
    facts: [{ category: "fact", content, confidence: 0.9, tags: [] }],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } satisfies ExtractionResult;
}

/** Seed a recallable fact file directly on disk with PAST timestamps. */
export async function seedFactFile(memoryDir: string, id: string, content: string): Promise<string> {
  const created = pastIso();
  const dir = path.join(memoryDir, "facts", created.slice(0, 10));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.md`);
  await writeFile(
    file,
    [
      "---",
      `id: ${id}`,
      "category: fact",
      `created: ${created}`,
      `updated: ${created}`,
      "source: extraction",
      "confidence: 0.9",
      "confidenceTier: explicit",
      "---",
      "",
      content,
      "",
    ].join("\n"),
    "utf-8",
  );
  return file;
}

/** All markdown files under `root` (recursive); [] when the dir is absent. */
export async function markdownFilesUnder(root: string): Promise<string[]> {
  try {
    const entries = (await readdir(root, { recursive: true })) as string[];
    return entries.filter((entry) => entry.endsWith(".md")).map((entry) => path.join(root, entry));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** Markdown files under `root` whose body contains `needle`. */
export async function memoryFilesContaining(root: string, needle: string): Promise<string[]> {
  const files = await markdownFilesUnder(root);
  const hits: string[] = [];
  for (const file of files) {
    const body = await readFile(file, "utf-8");
    if (body.includes(needle)) hits.push(file);
  }
  return hits;
}

/** Poll `probe` until it yields a truthy value (async effects settle out-of-band). */
export async function eventually<T>(
  probe: () => Promise<T | null | undefined | false>,
  label: string,
  timeoutMs = 5000,
): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await sleep(25);
  }
}
