/**
 * Ingestion citation accuracy benchmark.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
} from "../../../types.js";
import type { ExtractedPage } from "../../../ingestion-types.js";
import type { BenchJudge } from "../../../adapters/types.js";
import { aggregateTaskScores, llmJudgeScoreDetailed, timed } from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import { emailFixture } from "../../../fixtures/inbox/email.js";

interface CitationClaimOutcome {
  claim: string;
  pageRef: string;
  judgeScore: number;
  deterministicSupport: number;
  valid: boolean;
}

const CITATION_SUPPORT_THRESHOLD = 0.72;

export const ingestionCitationAccuracyDefinition: BenchmarkDefinition = {
  id: "ingestion-citation-accuracy",
  title: "Ingestion: Citation Accuracy",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "ingestion-citation-accuracy",
    version: "1.0.0",
    description: "Verifies that claims in generated summaries cite valid source chunks via LLM judge.",
    category: "ingestion",
  },
};

/**
 * Extract a narrow context window around a sentence within the full text.
 * Returns up to 2 sentences before and after the target sentence so the judge
 * sees claim-specific evidence rather than the entire page body.
 */
function extractClaimContext(fullText: string, sentence: string): string {
  const sentences = fullText
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const idx = sentences.findIndex((s) => s.includes(sentence) || sentence.includes(s));
  if (idx < 0) return sentence;

  const start = Math.max(0, idx - 2);
  const end = Math.min(sentences.length, idx + 3);
  return sentences.slice(start, end).join(" ");
}

function extractClaims(
  pages: ExtractedPage[],
): Array<{ claim: string; claimContext: string; pageRef: string; sourceRefs?: string[]; seeAlso: string[] }> {
  const claims: Array<{ claim: string; claimContext: string; pageRef: string; sourceRefs?: string[]; seeAlso: string[] }> = [];
  for (const page of pages) {
    if (!page.content) continue;
    const sentences = page.content
      .split(/[.!?]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 20);
    for (const sentence of sentences) {
      claims.push({
        claim: sentence,
        claimContext: extractClaimContext(page.content, sentence),
        pageRef: page.path,
        sourceRefs: page.sourceRefs,
        seeAlso: page.seeAlso,
      });
    }
  }
  return claims;
}

/**
 * Build the cited source content for a claim by resolving dedicated source
 * references against the fixture file map. Legacy adapters that do not expose
 * sourceRefs can still use seeAlso as citation metadata, but adapters that
 * provide sourceRefs keep page backlinks separate from source-file citations.
 * Non-empty unresolved citation metadata is treated as unresolved rather than
 * as permission to search the full fixture corpus.
 */
function resolveCitedSources(
  sourceRefs: string[] | undefined,
  seeAlso: string[],
  pageRef: string,
  sourceContentMap: Map<string, string>,
): string {
  const resolved: string[] = [];
  const hasExplicitSourceRefs = sourceRefs !== undefined;
  const citationRefs = hasExplicitSourceRefs ? sourceRefs : seeAlso;
  const normalizedRefs: string[] = [];

  for (const ref of citationRefs) {
    if (typeof ref !== "string") {
      return "";
    }
    const normalizedRef = ref.trim();
    if (!normalizedRef) {
      return "";
    }
    normalizedRefs.push(normalizedRef);
  }

  if (hasExplicitSourceRefs && normalizedRefs.length === 0) {
    return "";
  }

  for (const ref of normalizedRefs) {
    const refBase = path.basename(ref).toLowerCase();
    let matched = false;
    for (const [relativePath, content] of sourceContentMap) {
      if (
        relativePath === ref ||
        relativePath.endsWith(ref) ||
        path.basename(relativePath).toLowerCase() === refBase
      ) {
        resolved.push(content);
        matched = true;
        break;
      }
    }
    if (hasExplicitSourceRefs && !matched) {
      return "";
    }
  }

  if (resolved.length > 0) {
    return resolved.join("\n\n---\n\n");
  }

  if (normalizedRefs.length > 0) {
    return "";
  }

  // Fall back to a source whose basename matches the page path
  const pageBase = path.basename(pageRef).toLowerCase();
  for (const [relativePath, content] of sourceContentMap) {
    if (path.basename(relativePath).toLowerCase() === pageBase) {
      return content;
    }
  }

  // Last resort: all sources (equivalent to original behaviour, but only reached
  // when citation metadata is entirely absent)
  return Array.from(sourceContentMap.values()).join("\n\n---\n\n");
}

export async function runIngestionCitationAccuracyBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  if (!options.ingestionAdapter) {
    throw new Error("ingestionAdapter is required for ingestion benchmarks");
  }
  const fixture = emailFixture.generate();

  const fixtureDir = await mkdtemp(path.join(tmpdir(), "bench-citation-"));
  try {
    await options.ingestionAdapter!.reset();

    for (const file of fixture.files) {
      const filePath = path.join(fixtureDir, file.relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, file.content, "utf8");
    }

    const benchmarkStart = performance.now();

    const { result: ingestionLog, durationMs: ingestionDurationMs } = await timed(async () =>
      options.ingestionAdapter!.ingest(await realpath(fixtureDir)),
    );

    if (ingestionLog.errors.length > 0) {
      const durationMs = Math.round(performance.now() - benchmarkStart);
      const message = ingestionLog.errors.join("; ");
      const tasks = [
        {
          taskId: `citation-accuracy-${fixture.id}`,
          question: `Verify citation accuracy for ${fixture.id} fixture`,
          expected: `All claims cite valid source chunks`,
          actual: `(ingestion error: ${message})`,
          scores: {
            total_claims: 0,
            valid_citations: 0,
            citation_accuracy: -1,
          },
          latencyMs: durationMs,
          tokens: { input: 0, output: 0 },
          details: {
            fixtureId: fixture.id,
            totalClaims: 0,
            scoredClaims: 0,
            validCitations: 0,
            citationAccuracy: -1,
            judgeAvailable: options.system?.judge !== undefined,
            judgeLatencyMs: 0,
            judgeModels: [],
            ingestionDurationMs,
            ingestionErrors: ingestionLog.errors,
            commandsIssued: ingestionLog.commandsIssued,
            promptsShown: ingestionLog.promptsShown,
            claimOutcomes: [],
          },
        },
      ];
      options.onTaskComplete?.(tasks[0]!, 1, 1);

      const remnicVersion = await getRemnicVersion();
      return {
        meta: {
          id: randomUUID(),
          benchmark: options.benchmark.id,
          benchmarkTier: options.benchmark.tier,
          version: options.benchmark.meta.version,
          remnicVersion,
          gitSha: getGitSha(),
          timestamp: new Date().toISOString(),
          mode: options.mode,
          runCount: 1,
          seeds: [options.seed ?? 0],
        },
        config: {
          systemProvider: options.systemProvider ?? null,
          judgeProvider: options.judgeProvider ?? null,
          adapterMode: options.adapterMode ?? "direct",
          remnicConfig: options.remnicConfig ?? {},
        },
        cost: {
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0,
          totalLatencyMs: durationMs,
          meanQueryLatencyMs: durationMs,
        },
        results: {
          tasks,
          aggregates: aggregateTaskScores(tasks.map((t) => t.scores)),
        },
        environment: {
          os: process.platform,
          nodeVersion: process.version,
          hardware: process.arch,
        },
      };
    }

    const graph = await options.ingestionAdapter.getMemoryGraph();
    const claims = extractClaims(graph.pages);

    const judge: BenchJudge | undefined = options.system?.judge;

    // Build a map from relativePath → content for citation-aware source resolution
    const sourceContentMap = new Map<string, string>(
      fixture.files.map((f) => [f.relativePath, f.content]),
    );

    let validCitations = 0;
    let scoredClaims = 0;
    let judgeInputTokens = 0;
    let judgeOutputTokens = 0;
    let judgeLatencyMs = 0;
    const judgeModels = new Set<string>();
    const claimOutcomes: CitationClaimOutcome[] = [];

    if (claims.length > 0) {
      for (const { claim, claimContext, pageRef, sourceRefs, seeAlso } of claims) {
        const citedSources = resolveCitedSources(sourceRefs, seeAlso, pageRef, sourceContentMap);
        const judgeResult = await llmJudgeScoreDetailed(
          judge,
          `Does the cited source content support this claim? Claim: "${claim}"`,
          claimContext,
          citedSources,
        );
        judgeInputTokens += judgeResult.tokens.input;
        judgeOutputTokens += judgeResult.tokens.output;
        judgeLatencyMs += judgeResult.latencyMs;
        if (judgeResult.model !== undefined) {
          judgeModels.add(judgeResult.model);
        }
        const score = judgeResult.score;
        const deterministicSupport = citationSupportScore(claim, citedSources);
        if (score >= 0) {
          scoredClaims += 1;
          const valid = score >= 0.5 || deterministicSupport >= CITATION_SUPPORT_THRESHOLD;
          if (valid) {
            validCitations += 1;
          }
          claimOutcomes.push({
            claim,
            pageRef,
            judgeScore: score,
            deterministicSupport,
            valid,
          });
        }
      }
    }

    // Total latency includes both ingestion and judge scoring time
    const totalDurationMs = Math.round(performance.now() - benchmarkStart);

    const citationAccuracy = scoredClaims > 0 ? validCitations / scoredClaims : -1;

    const scores: Record<string, number> = {
      total_claims: claims.length,
    };
    if (citationAccuracy >= 0) {
      scores.valid_citations = validCitations;
      scores.citation_accuracy = citationAccuracy;
    }

    const tasks = [
      {
        taskId: `citation-accuracy-${fixture.id}`,
        question: `Verify citation accuracy for ${fixture.id} fixture`,
        expected: `All claims cite valid source chunks`,
        actual: judge
          ? `${validCitations}/${scoredClaims} claims cite valid source chunks (${claims.length} total claims)`
          : `No judge available; ${claims.length} claims extracted`,
        scores,
        latencyMs: totalDurationMs,
        tokens: { input: judgeInputTokens, output: judgeOutputTokens },
        details: {
          fixtureId: fixture.id,
          totalClaims: claims.length,
          scoredClaims,
          validCitations,
          citationAccuracy,
          judgeAvailable: judge !== undefined,
          judgeLatencyMs,
          judgeModels: [...judgeModels],
          ingestionDurationMs,
          ingestionErrors: ingestionLog.errors,
          claimOutcomes,
        },
      },
    ];

    const remnicVersion = await getRemnicVersion();
    return {
      meta: {
        id: randomUUID(),
        benchmark: options.benchmark.id,
        benchmarkTier: options.benchmark.tier,
        version: options.benchmark.meta.version,
        remnicVersion,
        gitSha: getGitSha(),
        timestamp: new Date().toISOString(),
        mode: options.mode,
        runCount: 1,
        seeds: [options.seed ?? 0],
      },
      config: {
        systemProvider: options.systemProvider ?? null,
        judgeProvider: options.judgeProvider ?? null,
        adapterMode: options.adapterMode ?? "direct",
        remnicConfig: options.remnicConfig ?? {},
      },
      cost: {
        totalTokens: judgeInputTokens + judgeOutputTokens,
        inputTokens: judgeInputTokens,
        outputTokens: judgeOutputTokens,
        estimatedCostUsd: 0,
        totalLatencyMs: totalDurationMs,
        meanQueryLatencyMs: totalDurationMs,
      },
      results: {
        tasks,
        aggregates: aggregateTaskScores(tasks.map((t) => t.scores)),
      },
      environment: {
        os: process.platform,
        nodeVersion: process.version,
        hardware: process.arch,
      },
    };
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

function citationSupportScore(claim: string, citedSources: string): number {
  const normalizedClaim = normalizeSupportText(claim);
  const normalizedSources = normalizeSupportText(citedSources);
  if (normalizedClaim.length === 0 || normalizedSources.length === 0) {
    return 0;
  }
  if (normalizedSources.includes(normalizedClaim)) {
    return 1;
  }

  const claimTokens = significantSupportTokens(normalizedClaim);
  if (claimTokens.length === 0) {
    return 0;
  }

  const sourceTokens = new Set(significantSupportTokens(normalizedSources));
  const requiredNumericTokens = claimTokens.filter((token) => /\d/.test(token));
  if (requiredNumericTokens.some((token) => !sourceTokens.has(token))) {
    return 0;
  }

  const hits = claimTokens.filter((token) => sourceTokens.has(token)).length;
  return hits / claimTokens.length;
}

function significantSupportTokens(value: string): string[] {
  return [...new Set(value.split(/\s+/).filter(isSignificantSupportToken))];
}

function normalizeSupportText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSignificantSupportToken(token: string): boolean {
  if (token.length === 0) {
    return false;
  }
  if (/\d/.test(token)) {
    return true;
  }
  if (token.length <= 2) {
    return false;
  }
  return !CITATION_STOPWORDS.has(token);
}

const CITATION_STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "against",
  "also",
  "and",
  "are",
  "because",
  "been",
  "before",
  "being",
  "between",
  "but",
  "can",
  "could",
  "did",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "into",
  "not",
  "now",
  "our",
  "out",
  "over",
  "should",
  "that",
  "the",
  "their",
  "them",
  "there",
  "this",
  "through",
  "under",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would",
]);
