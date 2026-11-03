/**
 * Synthetic large-corpus fixture generator (performance-regression fixtures
 * for the corpus maintenance scans).
 *
 * Builds a realistic single-namespace memory store layout: hot category
 * directories with day partitions, a cold tier, and an entities/ directory.
 * File bodies are seeded deterministic text so parse work (frontmatter split,
 * tag/lineage parsing) is representative, not all-whitespace.
 *
 * Used by the event-loop regression tests (small scale, CI-stable) and by
 * scripts/bench-corpus-scans.ts (deployment scale) so measured claims and CI
 * guards exercise the same layout.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SyntheticCorpusOptions {
  /** Memory root the layout is written under (created if missing). */
  rootDir: string;
  /** Number of distinct `YYYY-MM-DD` day partitions per category. */
  days?: number;
  /** Hot memory files spread across the day partitions of EACH category. */
  filesPerCategory?: number;
  /** Hot categories to populate. Defaults to a recall-representative subset. */
  categories?: readonly string[];
  /** Cold-tier (demoted) memory files spread across the same partitions. */
  coldFiles?: number;
  /** Entity markdown files under `entities/`. */
  entityCount?: number;
  /** Deterministic body content seed. */
  seed?: number;
}

export interface SyntheticCorpusStats {
  rootDir: string;
  hotFiles: number;
  coldFiles: number;
  entityFiles: number;
  totalFiles: number;
}

const DEFAULT_CATEGORIES = ["facts", "decisions", "preferences", "procedures"] as const;

function dayPartition(index: number): string {
  // Real calendar days descending from a fixed date (not today) so fixtures
  // are deterministic across runs and CI machines.
  const date = new Date(Date.UTC(2026, 0, 28) - index * 86_400_000);
  return date.toISOString().slice(0, 10);
}

/** Deterministic pseudo-content: seeded, ~200-400 byte markdown bodies. */
function body(seed: number, index: number): string {
  const words: string[] = [];
  let state = (seed * 2654435761 + index * 40503) >>> 0;
  for (let i = 0; i < 40; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    words.push(`w${state % 9973}`);
  }
  return `Synthetic memory body ${index}. ${words.join(" ")}`;
}

function memoryMarkdown(id: string, category: string, seed: number, index: number): string {
  const created = "2026-01-15T09:30:00.000Z";
  return [
    "---",
    `id: ${id}`,
    `category: ${category}`,
    `created: ${created}`,
    `updated: ${created}`,
    "source: synthetic",
    `confidence: ${(0.5 + ((index % 50) / 100)).toFixed(2)}`,
    'tags: ["synthetic", "fixture"]',
    `lineage: ["synthetic/${index % 7}.md:1"]`,
    "---",
    "",
    body(seed, index),
    "",
  ].join("\n");
}

function entityMarkdown(id: string, seed: number, index: number): string {
  return [
    "---",
    `id: ${id}`,
    "category: entity",
    `name: Synthetic Entity ${index}`,
    "type: concept",
    `created: 2026-01-15T09:30:00.000Z`,
    'tags: ["synthetic"]',
    "---",
    "",
    body(seed, index),
    "",
  ].join("\n");
}

/** Write a synthetic memory-store layout under `rootDir`. Idempotent per fresh dir. */
export async function makeSyntheticCorpus(options: SyntheticCorpusOptions): Promise<SyntheticCorpusStats> {
  const {
    rootDir,
    days = 30,
    filesPerCategory = 0,
    categories = DEFAULT_CATEGORIES,
    coldFiles = 0,
    entityCount = 0,
    seed = 7,
  } = options;

  let hotFiles = 0;
  let coldCount = 0;

  for (const [categoryIndex, category] of categories.entries()) {
    const perDay = Math.ceil(filesPerCategory / days);
    let written = 0;
    for (let day = 0; day < days && written < filesPerCategory; day += 1) {
      const dir = path.join(rootDir, category, dayPartition(day));
      await mkdir(dir, { recursive: true });
      const count = Math.min(perDay, filesPerCategory - written);
      const batch: Promise<unknown>[] = [];
      for (let i = 0; i < count; i += 1) {
        const id = `${category}-${day}-${i}`;
        batch.push(
          writeFile(path.join(dir, `${id}.md`), memoryMarkdown(id, category, seed, hotFiles + i), "utf-8"),
        );
      }
      await Promise.all(batch);
      written += count;
      hotFiles += count;
    }
    void categoryIndex;
  }

  if (coldFiles > 0) {
    const perDay = Math.ceil(coldFiles / days);
    let written = 0;
    for (let day = 0; day < days && written < coldFiles; day += 1) {
      const dir = path.join(rootDir, "cold", "facts", dayPartition(day));
      await mkdir(dir, { recursive: true });
      const count = Math.min(perDay, coldFiles - written);
      const batch: Promise<unknown>[] = [];
      for (let i = 0; i < count; i += 1) {
        const id = `cold-fact-${day}-${i}`;
        batch.push(
          writeFile(path.join(dir, `${id}.md`), memoryMarkdown(id, "fact", seed, 1_000_000 + written + i), "utf-8"),
        );
      }
      await Promise.all(batch);
      written += count;
      coldCount += count;
    }
  }

  if (entityCount > 0) {
    const dir = path.join(rootDir, "entities");
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < entityCount; i += 500) {
      const batch: Promise<unknown>[] = [];
      for (let j = i; j < Math.min(i + 500, entityCount); j += 1) {
        const id = `entity-${j}`;
        batch.push(writeFile(path.join(dir, `${id}.md`), entityMarkdown(id, seed, j), "utf-8"));
      }
      await Promise.all(batch);
    }
  }

  return { rootDir, hotFiles, coldFiles: coldCount, entityFiles: entityCount, totalFiles: hotFiles + coldCount + entityCount };
}
