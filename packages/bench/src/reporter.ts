/**
 * Result enrichment and JSON writing helpers.
 */

import { execSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LegacyBenchmarkResult } from "./adapters/types.js";
import { resolveContainedPath, sanitizeFilenameSegment } from "./filename-safety.js";
import { writeLeaderboardArtifactsForResult } from "./leaderboard-export.js";
import { isSecretKey } from "./security/secret-keys.js";
import type { BenchmarkResult } from "./types.js";

const REDACTED_SECRET = "[REDACTED]";
const PROCESS_GIT_SHA = readGitSha();

export function redactBenchmarkResultSecrets<T>(value: T): T {
  return redactSecrets(value) as T;
}

export function sanitizeBenchmarkResultForJson<T>(value: T): T {
  return sanitizeForJson(value) as T;
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    redacted[key] = isSecretKey(key)
      ? REDACTED_SECRET
      : redactSecrets(nestedValue);
  }
  return redacted;
}

function sanitizeForJson(value: unknown): unknown {
  if (typeof value === "string") {
    return replaceLoneSurrogates(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForJson(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    sanitized[replaceLoneSurrogates(key)] = sanitizeForJson(nestedValue);
  }
  return sanitized;
}

function replaceLoneSurrogates(value: string): string {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value[index] + value[index + 1];
        index += 1;
      } else {
        out += "\uFFFD";
      }
      continue;
    }

    if (code >= 0xdc00 && code <= 0xdfff) {
      out += "\uFFFD";
      continue;
    }

    out += value[index];
  }
  return out;
}

export async function writeBenchmarkResult(
  result: BenchmarkResult,
  outputDir: string,
): Promise<string> {
  const outputRoot = path.resolve(outputDir);
  await mkdir(outputRoot, { recursive: true });

  const safeBenchmark = sanitizeFilenameSegment(result.meta.benchmark);
  const safeRemnicVersion = sanitizeFilenameSegment(result.meta.remnicVersion);
  const timestamp = sanitizeFilenameSegment(
    result.meta.timestamp.replace(/[:.]/g, "-"),
  );
  const filePath = resolveContainedPath(
    outputRoot,
    `${safeBenchmark}-v${safeRemnicVersion}-${timestamp}.json`,
  );
  const leaderboardArtifacts = await writeLeaderboardArtifactsForResult(
    result,
    outputRoot,
  ).catch((error: unknown) => [
    {
      benchmark: result.meta.benchmark,
      path: "",
      format: "leaderboard-artifact-error",
      records: 0,
      error: error instanceof Error ? error.message : String(error),
    },
  ]);

  const resultWithArtifacts = {
    ...result,
    config: {
      ...result.config,
      benchmarkOptions: {
        ...(result.config.benchmarkOptions ?? {}),
        leaderboardArtifacts,
      },
    },
  };

  const publicResult = sanitizeBenchmarkResultForJson(
    redactBenchmarkResultSecrets(resultWithArtifacts),
  );
  await writeFile(filePath, JSON.stringify(publicResult, null, 2) + "\n");
  return filePath;
}

export async function getRemnicVersion(): Promise<string> {
  try {
    const packageJson = JSON.parse(
      await readFile(
        path.resolve(import.meta.dirname, "../../../package.json"),
        "utf8",
      ),
    ) as { version?: string };

    return typeof packageJson.version === "string"
      ? packageJson.version
      : "unknown";
  } catch {
    return "unknown";
  }
}

export function getGitSha(): string {
  return PROCESS_GIT_SHA;
}

function readGitSha(): string {
  const explicitSha =
    process.env.REMNIC_BENCH_GIT_SHA ??
    process.env.GITHUB_SHA ??
    process.env.CI_COMMIT_SHA;
  if (typeof explicitSha === "string" && explicitSha.trim().length > 0) {
    return explicitSha.trim().slice(0, 40);
  }

  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export function enrichResult(result: LegacyBenchmarkResult): LegacyBenchmarkResult {
  return {
    ...result,
    engramVersion: result.engramVersion || "unknown",
    gitSha: result.gitSha || getGitSha(),
    timestamp: result.timestamp || new Date().toISOString(),
  };
}
