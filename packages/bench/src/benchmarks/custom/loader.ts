/**
 * YAML custom benchmark loader.
 */

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { BenchmarkCategory } from "../../types.js";
import type {
  CustomBenchmarkScoring,
  CustomBenchmarkSpec,
  CustomBenchmarkTask,
} from "./types.js";

const CUSTOM_SCORING_VALUES = new Set<CustomBenchmarkScoring>([
  "exact_match",
  "f1",
  "rouge_l",
  "llm_judge",
]);

const CUSTOM_CATEGORIES = new Set<BenchmarkCategory>([
  "agentic",
  "retrieval",
  "conversational",
  "ingestion",
]);

export function parseCustomBenchmark(source: string): CustomBenchmarkSpec {
  return normalizeCustomBenchmark(parseYaml(source));
}

export async function loadCustomBenchmarkFile(
  filePath: string,
): Promise<CustomBenchmarkSpec> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `Failed to read custom benchmark file ${filePath}: ${formatError(error)}`,
    );
  }

  try {
    return parseCustomBenchmark(source);
  } catch (error) {
    throw new Error(
      `Custom benchmark file ${filePath} is invalid: ${formatError(error)}`,
    );
  }
}

function normalizeCustomBenchmark(raw: unknown): CustomBenchmarkSpec {
  const record = expectRecord(raw, "Custom benchmark YAML must parse to an object.");
  const name = readText(record.name, "Custom benchmark name");
  const description = readOptionalText(record.description, "Custom benchmark description");
  const version = readOptionalText(record.version, "Custom benchmark version") ?? "1.0.0";
  const scoring = readScoring(record.scoring);
  const category = readCategory(record.category) ?? "retrieval";
  const citation = readOptionalText(record.citation, "Custom benchmark citation");
  const tasks = readTasks(record.tasks);

  if (tasks.length === 0) {
    throw new Error(`Custom benchmark "${name}" must include at least one task.`);
  }

  return {
    name,
    description,
    version,
    category,
    citation,
    scoring,
    tasks,
  };
}

function readTasks(value: unknown): CustomBenchmarkTask[] {
  if (!Array.isArray(value)) {
    throw new Error("Custom benchmark tasks must be an array.");
  }

  return value.map((task, index) => normalizeTask(task, index));
}

function normalizeTask(value: unknown, index: number): CustomBenchmarkTask {
  const label = `Custom benchmark task ${index + 1}`;
  const record = expectRecord(value, `${label} must be an object.`);
  const question = readText(record.question, `${label} question`);
  const expected = readText(record.expected, `${label} expected`);
  const tags = readOptionalTextArray(record.tags, `${label} tags`);

  return tags ? { question, expected, tags } : { question, expected };
}

function readScoring(value: unknown): CustomBenchmarkScoring {
  const scoring = readText(value, "Custom benchmark scoring");
  if (!CUSTOM_SCORING_VALUES.has(scoring as CustomBenchmarkScoring)) {
    throw new Error(
      `Custom benchmark scoring must be one of ${[...CUSTOM_SCORING_VALUES].join(", ")}.`,
    );
  }
  return scoring as CustomBenchmarkScoring;
}

function readCategory(value: unknown): BenchmarkCategory | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const category = readText(value, "Custom benchmark category");
  if (!CUSTOM_CATEGORIES.has(category as BenchmarkCategory)) {
    throw new Error(
      `Custom benchmark category must be one of ${[...CUSTOM_CATEGORIES].join(", ")}.`,
    );
  }
  return category as BenchmarkCategory;
}

function readOptionalTextArray(
  value: unknown,
  label: string,
): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings.`);
  }

  return value.map((item, index) => readText(item, `${label}[${index + 1}]`));
}

function readOptionalText(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return readText(value, label);
}

function readText(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a non-empty string.`);
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return normalized;
}

function expectRecord(
  value: unknown,
  message: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }

  return value as Record<string, unknown>;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
