import type { BaseTask, H6BenchmarkDataset } from "./types.js";
import type { ValidationIssue } from "./validator.js";

const STATE_DEFINING_JACCARD_THRESHOLD = 0.60;

export function tokenizeContent(text: string): Set<string> {
  return new Set(
    text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(" ")
      .filter(Boolean),
  );
}

export function calculateJaccardSimilarity(textA: string, textB: string): number {
  const setA = tokenizeContent(textA);
  const setB = tokenizeContent(textB);
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

export function calculateTrigramSimilarity(textA: string, textB: string): number {
  const trigrams = (text: string): Set<string> => {
    const tokens = text
      .toLowerCase()
      .replace(/[^a-z0-9_\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2);
    return new Set(tokens.slice(0, -2).map(
      (token, index) => `${token}:${tokens[index + 1]}:${tokens[index + 2]}`,
    ));
  };
  const left = trigrams(textA);
  const right = trigrams(textB);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

export function normalizedTaskLogic(task: BaseTask): string {
  const variant = task.variants[0];
  const relevantPaths = new Set([task.fingerprint.file, "test/check.js"]);
  const sections = [
    ...variant.files
      .filter((file) => relevantPaths.has(file.path))
      .map((file) => `baseline:${file.path}\n${file.content}`),
    ...variant.badStrategyPatch.files
      .filter((file) => relevantPaths.has(file.path))
      .map((file) => `candidate:${file.path}\n${file.content}`),
    ...variant.goodStrategyPatch.files
      .filter((file) => relevantPaths.has(file.path))
      .map((file) => `candidate:${file.path}\n${file.content}`),
  ];
  return sections
    .join("\n")
    .replaceAll(task.domain, "<domain>")
    .replaceAll(task.domain.replaceAll("-", "_"), "<domain_token>");
}

function normalizeStateDefiningContent(task: BaseTask, content: string): string {
  return content
    .normalize("NFKC")
    .replaceAll(task.domain, "<domain>")
    .replaceAll(task.domain.replaceAll("-", "_"), "<domain_token>")
    .replace(/_[a-f0-9]{10}\b/gi, "_task")
    .replace(/(["'`])(?:\\.|(?!\1).)*\1/gs, "<literal>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<number>");
}

function stateDefiningContent(task: BaseTask, filePath: string): string {
  const file = task.variants[0].files.find((candidate) => candidate.path === filePath);
  if (!file) throw new Error(`Missing state-defining file ${filePath} in ${task.id}`);
  return normalizeStateDefiningContent(task, file.content);
}

export function validateH6StateDefiningIndependence(
  dataset: H6BenchmarkDataset,
): { maxSimilarity: number; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  let maxSimilarity = 0;
  for (let i = 0; i < dataset.tasks.length; i++) {
    for (let j = i + 1; j < dataset.tasks.length; j++) {
      const leftTask = dataset.tasks[i];
      const rightTask = dataset.tasks[j];
      if (leftTask.trapId !== rightTask.trapId) continue;
      const comparisons = [
        {
          kind: "source",
          leftPath: leftTask.fingerprint.file,
          rightPath: rightTask.fingerprint.file,
        },
        {
          kind: "check",
          leftPath: "test/check.js",
          rightPath: "test/check.js",
        },
      ] as const;
      for (const comparison of comparisons) {
        const similarity = calculateJaccardSimilarity(
          stateDefiningContent(leftTask, comparison.leftPath),
          stateDefiningContent(rightTask, comparison.rightPath),
        );
        maxSimilarity = Math.max(maxSimilarity, similarity);
        if (similarity > STATE_DEFINING_JACCARD_THRESHOLD) {
          issues.push({
            code: "STATE_DEFINING_SIMILARITY_EXCEEDED",
            message:
              `Tasks ${leftTask.id} and ${rightTask.id} state-defining ${comparison.kind} files ` +
              `${comparison.leftPath} and ${comparison.rightPath} normalized token-set Jaccard ` +
              `${similarity.toFixed(3)} exceeds ${STATE_DEFINING_JACCARD_THRESHOLD.toFixed(2)} threshold`,
            path: comparison.leftPath,
          });
        }
      }
    }
  }
  return { maxSimilarity, issues };
}
