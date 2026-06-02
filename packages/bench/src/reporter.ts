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
import { redactUrlSecrets as redactUrlSecretMaterial } from "./security/url-secrets.js";
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

  if (typeof value === "string") {
    return redactFreeformStringSecrets(value);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    redacted[key] = isSensitiveResultKey(key) ? REDACTED_SECRET : redactSecrets(nestedValue);
  }
  return redacted;
}

function redactFreeformStringSecrets(value: string): string {
  const structuredRedaction = redactStructuredStringSecrets(value);
  if (structuredRedaction !== undefined) return structuredRedaction;
  return redactSecretAssignments(redactAuthorizationSchemes(redactFreeformUrlSecrets(value)));
}

function redactStructuredStringSecrets(value: string): string | undefined {
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const redacted = redactJsonValueSecrets(parsed);
    if (!redacted.changed) return value;
    return JSON.stringify(redacted.value);
  } catch {
    return undefined;
  }
}

function redactJsonValueSecrets(value: unknown): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const entries = value.map((item) => {
      const redactedItem = redactJsonValueSecrets(item);
      changed ||= redactedItem.changed;
      return redactedItem.value;
    });
    return { value: entries, changed };
  }

  if (typeof value === "string") {
    const redactedValue = redactSecretAssignments(redactAuthorizationSchemes(redactFreeformUrlSecrets(value)));
    return { value: redactedValue, changed: redactedValue !== value };
  }

  if (!value || typeof value !== "object") {
    return { value, changed: false };
  }

  const redacted: Record<string, unknown> = {};
  let changed = false;
  for (const [key, nestedValue] of Object.entries(value)) {
    if (isSensitiveResultKey(key)) {
      redacted[key] = REDACTED_SECRET;
      changed = true;
      continue;
    }
    const redactedNestedValue = redactJsonValueSecrets(nestedValue);
    redacted[key] = redactedNestedValue.value;
    changed ||= redactedNestedValue.changed;
  }
  return { value: redacted, changed };
}

function redactAuthorizationSchemes(value: string): string {
  return value.replace(
    /\b(authorization)\b(\s*[:=]\s*)(bearer|basic|digest)(\s+)("[^"]+"|'[^']+'|[^\s,;}]+)/gi,
    (_match, key: string, separator: string, scheme: string, space: string, secret: string) =>
      `${key}${separator}${scheme}${space}${redactSecretLiteral(secret)}`
  );
}

function redactSecretAssignments(value: string): string {
  let redacted = "";
  let cursor = 0;

  for (let index = 0; index < value.length; index += 1) {
    const parsed = parseSecretAssignment(value, index);
    if (!parsed) continue;
    if (!isSensitiveResultKey(parsed.key) || isAuthorizationAssignmentScheme(parsed.rawValue)) continue;
    const valueEnd = isCookieResultKey(parsed.key)
      ? findCookieAssignmentValueEnd(value, parsed.valueStart, parsed.valueEnd)
      : parsed.valueEnd;
    const rawValue = value.slice(parsed.valueStart, valueEnd);

    redacted += value.slice(cursor, parsed.valueStart);
    redacted += redactSecretLiteral(rawValue);
    cursor = valueEnd;
    index = valueEnd - 1;
  }

  return cursor === 0 ? value : redacted + value.slice(cursor);
}

function parseSecretAssignment(
  value: string,
  startIndex: number
): { key: string; valueStart: number; valueEnd: number; rawValue: string } | undefined {
  if (startIndex > 0 && isAssignmentKeyChar(value[startIndex - 1])) return undefined;
  let keyStart = startIndex;
  let keyEnd: number;
  const quote = value[startIndex];

  if (quote === '"' || quote === "'") {
    keyStart = startIndex + 1;
    keyEnd = value.indexOf(quote, keyStart);
    if (keyEnd === -1) return undefined;
  } else {
    if (!isAssignmentKeyChar(value[startIndex])) return undefined;
    keyEnd = keyStart;
    while (keyEnd < value.length && isAssignmentKeyChar(value[keyEnd]!) && keyEnd - keyStart <= 80) {
      keyEnd += 1;
    }
  }

  const key = value.slice(keyStart, keyEnd);
  if (key.length < 3 || key.length > 80) return undefined;

  let separatorIndex = quote === '"' || quote === "'" ? keyEnd + 1 : keyEnd;
  while (separatorIndex < value.length && /\s/.test(value[separatorIndex]!)) separatorIndex += 1;
  if (value[separatorIndex] !== ":" && value[separatorIndex] !== "=") return undefined;

  let valueStart = separatorIndex + 1;
  while (valueStart < value.length && /\s/.test(value[valueStart]!)) valueStart += 1;
  if (valueStart >= value.length) return undefined;

  let valueEnd: number;
  const valueQuote = value[valueStart];
  if (valueQuote === '"' || valueQuote === "'") {
    const closingQuote = value.indexOf(valueQuote, valueStart + 1);
    if (closingQuote === -1) return undefined;
    valueEnd = closingQuote + 1;
  } else {
    valueEnd = valueStart;
    while (valueEnd < value.length && !isAssignmentValueTerminator(value[valueEnd]!)) valueEnd += 1;
  }

  return { key, valueStart, valueEnd, rawValue: value.slice(valueStart, valueEnd) };
}

function findCookieAssignmentValueEnd(value: string, valueStart: number, parsedValueEnd: number): number {
  const quote = value[valueStart];
  if (quote === '"' || quote === "'") return parsedValueEnd;
  let cursor = valueStart;
  while (cursor < value.length && !isCookieAssignmentValueTerminator(value[cursor]!)) cursor += 1;
  return cursor;
}

function isAssignmentKeyChar(char: string | undefined): boolean {
  return typeof char === "string" && /[A-Za-z0-9_.[\]-]/.test(char);
}

function isAssignmentValueTerminator(char: string): boolean {
  return /\s/.test(char) || char === "," || char === ";" || char === "}" || char === "&" || char === "#";
}

function isCookieAssignmentValueTerminator(char: string): boolean {
  return char === "\n" || char === "\r" || char === "," || char === "}" || char === "&" || char === "#";
}

function isAuthorizationAssignmentScheme(value: string): boolean {
  return /^(?:bearer|basic|digest)$/i.test(value.replace(/^["']|["']$/g, ""));
}

function redactSecretLiteral(value: string): string {
  const quote = value.length >= 2 && (value.startsWith('"') || value.startsWith("'")) ? value[0] : undefined;
  return quote && value.endsWith(quote) ? `${quote}${REDACTED_SECRET}${quote}` : REDACTED_SECRET;
}

function redactFreeformUrlSecrets(value: string): string {
  return redactUrlSecretMaterial(value, REDACTED_SECRET, isSensitiveResultKey);
}

function isSensitiveResultKey(key: string): boolean {
  const normalizedKey = normalizeSensitiveResultKey(key).toLowerCase();
  if (normalizedKey === "source-session") return false;
  return (
    isSecretKey(key) || normalizedKey === "cookie" || normalizedKey === "set-cookie" || normalizedKey === "session"
  );
}

function isCookieResultKey(key: string): boolean {
  return normalizeSensitiveResultKey(key).toLowerCase() === "cookie";
}

function normalizeSensitiveResultKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[\[\]._:]+/g, "-");
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

export async function writeBenchmarkResult(result: BenchmarkResult, outputDir: string): Promise<string> {
  const outputRoot = path.resolve(outputDir);
  await mkdir(outputRoot, { recursive: true });

  const safeBenchmark = sanitizeFilenameSegment(result.meta.benchmark);
  const safeRemnicVersion = sanitizeFilenameSegment(result.meta.remnicVersion);
  const timestamp = sanitizeFilenameSegment(result.meta.timestamp.replace(/[:.]/g, "-"));
  const filePath = resolveContainedPath(outputRoot, `${safeBenchmark}-v${safeRemnicVersion}-${timestamp}.json`);
  const publicBaseResult = sanitizeBenchmarkResultForJson(redactBenchmarkResultSecrets(result));
  const leaderboardArtifacts = await writeLeaderboardArtifactsForResult(publicBaseResult, outputRoot).catch(
    (error: unknown) => [
      {
        benchmark: publicBaseResult.meta.benchmark,
        path: "",
        format: "leaderboard-artifact-error",
        records: 0,
        error: error instanceof Error ? error.message : String(error),
      },
    ]
  );

  const resultWithArtifacts = {
    ...publicBaseResult,
    config: {
      ...publicBaseResult.config,
      benchmarkOptions: {
        ...(publicBaseResult.config.benchmarkOptions ?? {}),
        leaderboardArtifacts,
      },
    },
  };

  const publicResult = sanitizeBenchmarkResultForJson(redactBenchmarkResultSecrets(resultWithArtifacts));
  await writeFile(filePath, `${JSON.stringify(publicResult, null, 2)}\n`);
  return filePath;
}

export async function getRemnicVersion(): Promise<string> {
  try {
    const packageJson = JSON.parse(
      await readFile(path.resolve(import.meta.dirname, "../../../package.json"), "utf8")
    ) as { version?: string };

    return typeof packageJson.version === "string" ? packageJson.version : "unknown";
  } catch {
    return "unknown";
  }
}

export function getGitSha(): string {
  return PROCESS_GIT_SHA;
}

function readGitSha(): string {
  const explicitSha = process.env.REMNIC_BENCH_GIT_SHA ?? process.env.GITHUB_SHA ?? process.env.CI_COMMIT_SHA;
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
