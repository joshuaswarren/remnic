import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, readlink, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listBenchmarkResults, loadBenchmarkResult } from "./results-store.js";
import { resolveBenchmarkRunId } from "./run-identity.js";
import { redactUrlSecrets as redactUrlSecretMaterial } from "./security/url-secrets.js";
import type { BenchmarkMode, BenchmarkResult } from "./types.js";

export const BENCHMARK_REPRO_MANIFEST_FILENAME = "MANIFEST.json";
export const BENCHMARK_REPRO_MANIFEST_SCHEMA_VERSION = 1;

export interface BenchmarkReproManifestFile {
  path: string;
  kind: "file" | "symlink";
  sizeBytes: number;
  sha256: string;
  target?: string;
}

export interface BenchmarkReproManifestDataset {
  benchmark: string;
  status: "not-provided" | "missing" | "hashed";
  path?: string;
  realpath?: string;
  fileCount: number;
  totalBytes: number;
  sha256?: string;
  files: BenchmarkReproManifestFile[];
}

export interface BenchmarkReproManifestResult {
  path: string;
  sha256: string;
  sizeBytes: number;
  resultId: string;
  benchmark: string;
  mode: BenchmarkMode;
  gitSha: string;
  runCount: number;
  seeds: number[];
  taskCount: number;
  configHash: string;
}

export interface BenchmarkReproManifest {
  schemaVersion: number;
  generatedAt: string;
  run: {
    id: string;
    mode?: BenchmarkMode;
    selectedBenchmarks: string[];
    runtimeProfiles: string[];
    selectedWorkItems: Array<{
      benchmark: string;
      runtimeProfile: string;
    }>;
    limit?: number;
    seed?: number;
  };
  git: {
    commit: string;
    shortCommit: string;
    dirty: boolean;
    dirtyEntryCount: number;
  };
  command: {
    cwd: string;
    argv: string[];
    envKeys: string[];
  };
  environment: {
    platform: NodeJS.Platform;
    arch: string;
    nodeVersion: string;
    hostname: string;
    packageManager?: string;
  };
  qmd?: {
    configDir?: string;
    cacheDir?: string;
    collections: string[];
  };
  configFiles: Array<{
    label: string;
    path: string;
    sha256?: string;
    sizeBytes?: number;
    missing?: boolean;
    redacted?: boolean;
  }>;
  datasets: BenchmarkReproManifestDataset[];
  results: BenchmarkReproManifestResult[];
  artifactHash: string;
}

export interface BuildBenchmarkReproManifestOptions {
  resultPaths?: string[];
  runId?: string;
  selectedBenchmarks?: string[];
  runtimeProfiles?: string[];
  selectedWorkItems?: Array<{
    benchmark: string;
    runtimeProfile: string;
  }>;
  mode?: BenchmarkMode;
  limit?: number;
  seed?: number;
  datasetDirs?: Record<string, string | undefined>;
  command?: {
    cwd?: string;
    argv?: string[];
    env?: NodeJS.ProcessEnv;
    envKeys?: string[];
  };
  configFiles?: Array<{ label: string; path?: string }>;
  qmd?: {
    configDir?: string;
    cacheDir?: string;
    collections?: string[];
  };
}

const SECRET_ARG_FLAGS = new Set([
  "--api-key",
  "--system-api-key",
  "--judge-api-key",
  "--token",
  "--auth-token",
  "-k",
  "-p",
  "-t",
]);

const ATTACHED_LONG_SECRET_ARG_FLAGS = [
  "--system-api-key",
  "--judge-api-key",
  "--auth-token",
  "--api-key",
  "--token",
] as const;

const NON_SECRET_ARG_FLAGS = new Set([
  "--ama-bench-cross-judge-base-url",
  "--base-url",
  "--config",
  "--dataset-dir",
  "--header",
  "--internal-base-url",
  "--judge-base-url",
  "--limit",
  "--max-tokens",
  "--mode",
  "--output-token-limit",
  "--provider-config",
  "--system-base-url",
]);

const BENCH_OPTION_BOUNDARY_FLAGS = new Set([
  "--all",
  "--ama-bench-cross-judge-api-key",
  "--ama-bench-cross-judge-base-url",
  "--ama-bench-cross-judge-codex-reasoning-effort",
  "--ama-bench-cross-judge-model",
  "--ama-bench-cross-judge-provider",
  "--ama-bench-judge-protocol",
  "--base-url",
  "--baselines-dir",
  "--custom",
  "--dataset",
  "--dataset-dir",
  "--detail",
  "--disable-thinking",
  "--drain-timeout",
  "--dry-run",
  "--explain",
  "--fast-gateway-agent-id",
  "--format",
  "--gateway-agent-id",
  "--help",
  "--ingest-concurrency",
  "--internal-api-key",
  "--internal-base-url",
  "--internal-codex-reasoning-effort",
  "--internal-disable-thinking",
  "--internal-model",
  "--internal-provider",
  "--json",
  "--judge-api-key",
  "--judge-base-url",
  "--judge-codex-reasoning-effort",
  "--judge-model",
  "--judge-provider",
  "--limit",
  "--matrix",
  "--max-429-wait",
  "--model",
  "--model-source",
  "--name",
  "--openclaw-config",
  "--out",
  "--output",
  "--provider",
  "--quick",
  "--remnic-config",
  "--request-timeout",
  "--results-dir",
  "--resume",
  "--retry-failed",
  "--runtime-profile",
  "--seed",
  "--system-api-key",
  "--system-base-url",
  "--system-codex-reasoning-effort",
  "--system-model",
  "--system-provider",
  "--system-responder-context-budget-chars",
  "--system-responder-prompt-budget-chars",
  "--target",
  "--task-filter",
  "--threshold",
  "--trial-concurrency",
  "--trial-limit",
  "-h",
]);

const SECRET_KEY_PATTERN =
  /(^|[-_])(?:api[-_]?key|secret[-_]?access[-_]?key|secret[-_]?key|client[-_]?secret(?:[-_]?key)?|app[-_]?secret(?:[-_]?key)?|provider[-_]?secret(?:[-_]?key)?|access[-_]?key|private[-_]?key|secret|password|authorization|credential|access[-_]?token|auth[-_]?token|refresh[-_]?token|id[-_]?token|token)$/i;

const REDACTED_ARG_VALUE = "[redacted]";

function sha256String(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Buffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function sanitizeArgv(argv: string[]): string[] {
  const sanitized: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const isOptionFlag = arg.startsWith("-");
    const assignmentIndex = arg.indexOf("=");
    const flagName = assignmentIndex === -1 ? arg : arg.slice(0, assignmentIndex);
    const attachedShortSecretFlag = getAttachedShortSecretFlag(arg);
    const attachedLongSecret = getAttachedLongSecretArg(arg);
    if (attachedLongSecret) {
      sanitized.push(`${attachedLongSecret.flag}${attachedLongSecret.delimiter}${REDACTED_ARG_VALUE}`);
      const attachedSecretValue = arg.slice(
        attachedLongSecret.flag.length + (attachedLongSecret.delimiter === "=" ? 1 : 0)
      );
      if (shouldConsumeAuthSchemePair(attachedLongSecret.flag, attachedSecretValue)) {
        const consumedValues = countAuthSchemeContinuationTokens(attachedLongSecret.flag, argv, index + 1);
        sanitized.push(...redactedPlaceholders(consumedValues));
        index += consumedValues;
      }
      continue;
    }
    if (attachedShortSecretFlag) {
      sanitized.push(`${attachedShortSecretFlag}${REDACTED_ARG_VALUE}`);
      continue;
    }
    const secretDelimiterIndex = assignmentIndex === -1 ? findSecretConfigDelimiterIndex(arg) : -1;
    if (secretDelimiterIndex !== -1) {
      sanitized.push(sanitizeSecretDelimitedArg(arg, secretDelimiterIndex, ":"));
      if (arg.slice(secretDelimiterIndex + 1).trim().length === 0) {
        index += countBareSecretValueTokens(arg.slice(0, secretDelimiterIndex), argv, index + 1);
      }
      continue;
    }
    if (isOptionFlag && (SECRET_ARG_FLAGS.has(flagName) || isSecretOptionFlagName(flagName))) {
      if (assignmentIndex !== -1) {
        const assignedSecretValue = arg.slice(assignmentIndex + 1);
        sanitized.push(`${flagName}=${REDACTED_ARG_VALUE}`);
        if (shouldConsumeAuthSchemePair(flagName, assignedSecretValue)) {
          const consumedValues = countAuthSchemeContinuationTokens(flagName, argv, index + 1);
          sanitized.push(...redactedPlaceholders(consumedValues));
          index += consumedValues;
        }
      } else {
        sanitized.push(arg);
        if (index + 1 < argv.length && shouldConsumeSeparatedSecretFlagValue(argv[index + 1]!)) {
          const consumeAllValueTokens =
            isAuthorizationConfigKey(flagName) ||
            ((flagName === "--auth-token" || flagName === "--token") && isAuthSchemeToken(argv[index + 1]!));
          let consumedValues = 1;
          while (
            consumeAllValueTokens &&
            index + 1 + consumedValues < argv.length &&
            !isOptionValueBoundaryFlag(argv[index + 1 + consumedValues]!)
          ) {
            consumedValues += 1;
          }
          sanitized.push(...redactedPlaceholders(consumedValues));
          index += consumedValues;
        }
      }
      continue;
    }
    if (assignmentIndex === -1 && isKnownNonSecretOptionFlag(arg)) {
      sanitized.push(arg);
      if (index + 1 < argv.length && !argv[index + 1]!.startsWith("-")) {
        const optionValue = sanitizeOptionValueSpan(arg, argv, index + 1);
        sanitized.push(...optionValue.values);
        index += optionValue.consumed;
      }
      continue;
    }
    if (assignmentIndex !== -1 && isOptionFlag && NON_SECRET_ARG_FLAGS.has(getOptionName(arg))) {
      const assignedValue = arg.slice(assignmentIndex + 1);
      const assignedOptionName = getOptionName(arg);
      if (assignedOptionName === "--header") {
        const headerDelimiterIndex = findSensitiveHeaderDelimiterIndex(assignedValue);
        if (headerDelimiterIndex !== -1) {
          let consumedValues = 0;
          while (
            index + 1 + consumedValues < argv.length &&
            !isOptionValueBoundaryFlag(argv[index + 1 + consumedValues]!)
          ) {
            consumedValues += 1;
          }
          sanitized.push(
            `${assignedOptionName}=${sanitizeSecretDelimitedArg(
              assignedValue,
              headerDelimiterIndex,
              assignedValue[headerDelimiterIndex]!
            )}`
          );
          sanitized.push(...redactedPlaceholders(consumedValues));
          index += consumedValues;
          continue;
        }
      }
      const authSchemeAssignmentIndex = findAuthSchemeAssignmentIndex(assignedValue);
      if (authSchemeAssignmentIndex !== -1) {
        const authSchemeKey = assignedValue.slice(0, authSchemeAssignmentIndex);
        const consumedValues = countAuthSchemeContinuationTokens(authSchemeKey, argv, index + 1);
        if (consumedValues > 0) {
          sanitized.push(
            `${assignedOptionName}=${sanitizeAssignmentArg(assignedValue, authSchemeAssignmentIndex, false)}`
          );
          sanitized.push(...redactedPlaceholders(consumedValues));
          index += consumedValues;
          continue;
        }
      }
      const assignedValueIsSensitive =
        isSecretConfigKey(assignedValue) || (assignedOptionName === "--header" && isSensitiveHeaderKey(assignedValue));
      if (assignedValueIsSensitive && index + 1 < argv.length && !isOptionValueBoundaryFlag(argv[index + 1]!)) {
        let consumedValues = 1;
        if (
          shouldConsumeAuthSchemePair(assignedValue, argv[index + 1]!) &&
          index + 2 < argv.length &&
          !isOptionValueBoundaryFlag(argv[index + 2]!)
        ) {
          consumedValues = 2;
        } else {
          const consumeAllValueTokens = assignedOptionName === "--header" || isAuthorizationConfigKey(assignedValue);
          while (
            index + 1 + consumedValues < argv.length &&
            !isOptionValueBoundaryFlag(argv[index + 1 + consumedValues]!) &&
            consumeAllValueTokens
          ) {
            consumedValues += 1;
          }
        }
        sanitized.push(arg);
        sanitized.push(...redactedPlaceholders(consumedValues));
        index += consumedValues;
        continue;
      }
    }
    if (assignmentIndex !== -1) {
      const authSchemeAssignmentIndex = findAuthSchemeAssignmentIndex(arg);
      if (authSchemeAssignmentIndex !== -1) {
        const authSchemeKey = arg.slice(0, authSchemeAssignmentIndex);
        const consumedValues = countAuthSchemeContinuationTokens(authSchemeKey, argv, index + 1);
        sanitized.push(sanitizeAssignmentArg(arg, assignmentIndex, isOptionFlag));
        sanitized.push(...redactedPlaceholders(consumedValues));
        index += consumedValues;
        continue;
      }
      sanitized.push(sanitizeAssignmentArg(arg, assignmentIndex, isOptionFlag));
      continue;
    }
    if (!isOptionFlag && isSecretConfigKey(arg)) {
      sanitized.push(arg);
      const consumedValues = countBareSecretValueTokens(arg, argv, index + 1);
      sanitized.push(...redactedPlaceholders(consumedValues));
      index += consumedValues;
      continue;
    }
    sanitized.push(sanitizeStructuredArg(arg));
  }
  return sanitized;
}

function sanitizeOptionValueSpan(
  optionArg: string,
  argv: string[],
  startIndex: number
): { values: string[]; consumed: number } {
  const value = argv[startIndex]!;
  const optionName = getOptionName(optionArg);
  if (optionName === "--header") {
    const headerDelimiterIndex = findSensitiveHeaderDelimiterIndex(value);
    if (headerDelimiterIndex !== -1) {
      let consumed = 1;
      while (startIndex + consumed < argv.length && !isOptionValueBoundaryFlag(argv[startIndex + consumed]!)) {
        consumed += 1;
      }
      return {
        values: [
          sanitizeSecretDelimitedArg(value, headerDelimiterIndex, value[headerDelimiterIndex]!),
          ...redactedPlaceholders(consumed - 1),
        ],
        consumed,
      };
    }
    if (
      isSensitiveHeaderKey(value) &&
      startIndex + 1 < argv.length &&
      !isOptionValueBoundaryFlag(argv[startIndex + 1]!)
    ) {
      let consumed = 2;
      while (startIndex + consumed < argv.length && !isOptionValueBoundaryFlag(argv[startIndex + consumed]!)) {
        consumed += 1;
      }
      return { values: [value, ...redactedPlaceholders(consumed - 1)], consumed };
    }
  }
  const secretDelimiterIndex = findSecretConfigDelimiterIndex(value);
  if (secretDelimiterIndex !== -1 && value.slice(secretDelimiterIndex + 1).trim().length === 0) {
    const secretKey = value.slice(0, secretDelimiterIndex);
    let consumed = 1;
    if (isAuthorizationConfigKey(secretKey)) {
      while (startIndex + consumed < argv.length && !isOptionValueBoundaryFlag(argv[startIndex + consumed]!)) {
        consumed += 1;
      }
    } else if (
      startIndex + 1 < argv.length &&
      shouldConsumeAuthSchemePair(secretKey, argv[startIndex + 1]!) &&
      startIndex + 2 < argv.length &&
      !isOptionValueBoundaryFlag(argv[startIndex + 2]!)
    ) {
      consumed = 3;
    } else if (startIndex + 1 < argv.length && !isOptionValueBoundaryFlag(argv[startIndex + 1]!)) {
      consumed = 2;
    }
    const continuationValues =
      consumed > 1 &&
      (isAuthorizationConfigKey(secretKey) ||
        (consumed > 2 && shouldConsumeAuthSchemePair(secretKey, argv[startIndex + 1]!)))
        ? redactedPlaceholders(consumed - 1)
        : [];
    return { values: [sanitizeSecretDelimitedArg(value, secretDelimiterIndex, ":"), ...continuationValues], consumed };
  }
  if (isSecretConfigKey(value) && startIndex + 1 < argv.length && !isOptionValueBoundaryFlag(argv[startIndex + 1]!)) {
    let consumed = 2;
    if (
      shouldConsumeAuthSchemePair(value, argv[startIndex + 1]!) &&
      startIndex + 2 < argv.length &&
      !isOptionValueBoundaryFlag(argv[startIndex + 2]!)
    ) {
      consumed = 3;
    } else if (isAuthorizationConfigKey(value)) {
      while (startIndex + consumed < argv.length && !isOptionValueBoundaryFlag(argv[startIndex + consumed]!)) {
        consumed += 1;
      }
    }
    return { values: [value, ...redactedPlaceholders(consumed - 1)], consumed };
  }
  const assignmentIndex = value.indexOf("=");
  if (assignmentIndex !== -1 && findAuthSchemeAssignmentIndex(value) !== -1) {
    const authSchemeKey = value.slice(0, assignmentIndex);
    const consumedContinuations = countAuthSchemeContinuationTokens(authSchemeKey, argv, startIndex + 1);
    if (consumedContinuations > 0) {
      return {
        values: [sanitizeAssignmentArg(value, assignmentIndex, false), ...redactedPlaceholders(consumedContinuations)],
        consumed: 1 + consumedContinuations,
      };
    }
  }
  return { values: [sanitizeOptionValueArg(value)], consumed: 1 };
}

function sanitizeOptionValueArg(arg: string): string {
  const sanitizedStructuredValue = sanitizeStructuredArg(arg);
  if (sanitizedStructuredValue !== arg) return sanitizedStructuredValue;
  const sanitizedUrlValue = sanitizeUrlSecrets(arg);
  if (sanitizedUrlValue !== arg) return sanitizedUrlValue;
  const assignmentIndex = arg.indexOf("=");
  if (assignmentIndex !== -1) return sanitizeAssignmentArg(arg, assignmentIndex, false);
  const secretDelimiterIndex = findSecretConfigDelimiterIndex(arg);
  if (secretDelimiterIndex !== -1) return sanitizeSecretDelimitedArg(arg, secretDelimiterIndex, ":");
  return arg;
}

function sanitizeAssignmentArg(arg: string, assignmentIndex: number, isOptionFlag: boolean): string {
  const key = arg.slice(0, assignmentIndex);
  const value = arg.slice(assignmentIndex + 1);
  if (isSensitiveHeaderKey(key)) return `${key}=${REDACTED_ARG_VALUE}`;
  const sanitizedStructuredValue = sanitizeStructuredArg(value);
  if (sanitizedStructuredValue !== value) return `${key}=${sanitizedStructuredValue}`;
  const sanitizedUrlValue = sanitizeUrlSecrets(value);
  if (sanitizedUrlValue !== value) return `${key}=${sanitizedUrlValue}`;
  const nestedHeaderDelimiterIndex = findSensitiveHeaderDelimiterIndex(value);
  if (nestedHeaderDelimiterIndex !== -1) {
    return `${key}=${sanitizeSecretDelimitedArg(value, nestedHeaderDelimiterIndex, value[nestedHeaderDelimiterIndex]!)}`;
  }
  const nestedSecretDelimiterIndex = findSecretConfigDelimiterIndex(value);
  if (nestedSecretDelimiterIndex !== -1) {
    const sanitizedValue = sanitizeSecretDelimitedArg(value, nestedSecretDelimiterIndex, ":");
    return sanitizedValue === value ? arg : `${key}=${sanitizedValue}`;
  }
  if (!isOptionFlag) return arg;
  const nestedAssignmentIndex = value.indexOf("=");
  if (nestedAssignmentIndex === -1) return arg;
  const sanitizedValue = sanitizeAssignmentArg(value, nestedAssignmentIndex, false);
  return sanitizedValue === value ? arg : `${key}=${sanitizedValue}`;
}

function findSecretConfigDelimiterIndex(arg: string): number {
  const trimmed = arg.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return -1;
  const delimiterIndex = arg.indexOf(":");
  if (delimiterIndex <= 0) return -1;
  const key = arg.slice(0, delimiterIndex);
  return isSensitiveHeaderKey(key) || isSensitiveHeaderKey(stripLeadingOptionPrefix(key)) ? delimiterIndex : -1;
}

function findSensitiveHeaderDelimiterIndex(arg: string): number {
  const colonIndex = arg.indexOf(":");
  const equalsIndex = arg.indexOf("=");
  const delimiterIndex =
    colonIndex === -1 ? equalsIndex : equalsIndex === -1 ? colonIndex : Math.min(colonIndex, equalsIndex);
  if (delimiterIndex <= 0) return -1;
  return isSensitiveHeaderKey(arg.slice(0, delimiterIndex)) ? delimiterIndex : -1;
}

function sanitizeSecretDelimitedArg(arg: string, delimiterIndex: number, delimiter: string): string {
  const key = arg.slice(0, delimiterIndex);
  const valueStart = skipLooseAssignmentWhitespace(arg, delimiterIndex + 1);
  const valueEnd =
    valueStart >= arg.length ? arg.length : findLooseAssignmentValueEnd(arg, valueStart, isRequestCookieHeaderKey(key));
  return `${arg.slice(0, delimiterIndex)}${delimiter}${REDACTED_ARG_VALUE}${arg.slice(valueEnd)}`;
}

function redactedPlaceholders(count: number): string[] {
  return Array.from({ length: Math.max(0, count) }, () => REDACTED_ARG_VALUE);
}

function sanitizeStructuredArg(arg: string): string {
  const sanitizedUrlArg = sanitizeUrlSecrets(arg);
  const trimmed = sanitizedUrlArg.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return sanitizeLooseSecretConfigText(sanitizedUrlArg);
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const redacted = redactStructuredSecrets(parsed);
    if (!redacted.changed) return sanitizedUrlArg;
    return JSON.stringify(redacted.value);
  } catch {
    return sanitizeLooseSecretConfigText(sanitizedUrlArg);
  }
}

function sanitizeLooseSecretConfigText(value: string): string {
  if (!value.includes(":") && !value.includes("=")) return value;
  let redacted = "";
  let cursor = 0;
  let changed = false;

  for (let index = 0; index < value.length; index += 1) {
    const delimiter = value[index];
    if (delimiter !== ":" && delimiter !== "=") continue;
    const keySpan = findLooseAssignmentKey(value, index);
    if (!keySpan || !isSensitiveHeaderKey(keySpan.key)) continue;
    const valueStart = skipLooseAssignmentWhitespace(value, index + 1);
    if (valueStart >= value.length) continue;
    const valueEnd = findLooseAssignmentValueEnd(value, valueStart, isRequestCookieHeaderKey(keySpan.key));
    redacted += value.slice(cursor, valueStart);
    redacted += REDACTED_ARG_VALUE;
    cursor = valueEnd;
    changed = true;
    index = valueEnd - 1;
  }

  return changed ? redacted + value.slice(cursor) : value;
}

function findLooseAssignmentKey(value: string, delimiterIndex: number): { key: string } | undefined {
  let keyEnd = delimiterIndex;
  while (keyEnd > 0 && isWhitespace(value[keyEnd - 1])) keyEnd -= 1;
  if (keyEnd <= 0) return undefined;

  const quote = value[keyEnd - 1];
  if (quote === '"' || quote === "'") {
    const keyStart = value.lastIndexOf(quote, keyEnd - 2);
    if (keyStart === -1) return undefined;
    const key = value.slice(keyStart + 1, keyEnd - 1);
    return key.length > 0 ? { key } : undefined;
  }

  let keyStart = keyEnd;
  while (keyStart > 0 && isLooseAssignmentKeyChar(value[keyStart - 1]!)) keyStart -= 1;
  const key = value.slice(keyStart, keyEnd);
  return key.length > 0 ? { key } : undefined;
}

function skipLooseAssignmentWhitespace(value: string, index: number): number {
  let cursor = index;
  while (cursor < value.length && isWhitespace(value[cursor])) cursor += 1;
  return cursor;
}

function findLooseAssignmentValueEnd(value: string, startIndex: number, consumeSemicolonPairs = false): number {
  const quote = value[startIndex];
  if (quote === '"' || quote === "'") {
    let cursor = startIndex + 1;
    let escaped = false;
    while (cursor < value.length) {
      const char = value[cursor];
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        return cursor + 1;
      }
      cursor += 1;
    }
    return value.length;
  }

  let cursor = startIndex;
  while (cursor < value.length && !isLooseAssignmentValueTerminator(value[cursor]!, consumeSemicolonPairs)) cursor += 1;
  return cursor;
}

function isLooseAssignmentKeyChar(char: string): boolean {
  return isAsciiAlnum(char) || char === "_" || char === "-" || char === "." || char === "[" || char === "]";
}

function isLooseAssignmentValueTerminator(char: string, consumeSemicolonPairs: boolean): boolean {
  return char === "," || char === "}" || char === "&" || (!consumeSemicolonPairs && char === ";");
}

function isWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function sanitizeUrlSecrets(value: string): string {
  return redactUrlSecretMaterial(value, REDACTED_ARG_VALUE, isSecretConfigKey);
}

function redactStructuredSecrets(value: unknown): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const entries = value.map((entry) => {
      const redactedEntry = redactStructuredSecrets(entry);
      changed ||= redactedEntry.changed;
      return redactedEntry.value;
    });
    return { value: entries, changed };
  }
  if (value && typeof value === "object") {
    let changed = false;
    const entries: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (isSensitiveHeaderKey(key)) {
        entries[key] = REDACTED_ARG_VALUE;
        changed = true;
        continue;
      }
      const redactedEntry = redactStructuredSecrets(entry);
      entries[key] = redactedEntry.value;
      changed ||= redactedEntry.changed;
    }
    return { value: entries, changed };
  }
  if (typeof value === "string") {
    let redactedValue = sanitizeUrlSecrets(value);
    const secretDelimiterIndex = findSecretConfigDelimiterIndex(redactedValue);
    if (secretDelimiterIndex !== -1) {
      redactedValue = sanitizeSecretDelimitedArg(redactedValue, secretDelimiterIndex, ":");
    }
    redactedValue = sanitizeLooseSecretConfigText(redactedValue);
    return { value: redactedValue, changed: redactedValue !== value };
  }
  return { value, changed: false };
}

function isSecretConfigKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(normalizeSecretKey(key));
}

function isSecretOptionFlagName(flagName: string): boolean {
  return isSecretConfigKey(flagName) || isSecretConfigKey(stripLeadingOptionPrefix(flagName));
}

function isAuthorizationConfigKey(key: string): boolean {
  return /(^|[-_])authorization$/i.test(normalizeSecretKey(key));
}

function isSensitiveHeaderKey(key: string): boolean {
  const normalized = normalizeSecretKey(key);
  return isSecretConfigKey(key) || /(^|[-_])(?:cookie|set[-_]?cookie|session)$/i.test(normalized);
}

function isRequestCookieHeaderKey(key: string): boolean {
  const parts = normalizeSecretKey(key).toLowerCase().split(/[-_]+/).filter(Boolean);
  const lastPart = parts.at(-1);
  const previousPart = parts.at(-2);
  return lastPart === "cookie" && previousPart !== "set";
}

function isAuthSchemeToken(value: string): boolean {
  return /^(?:bearer|basic|digest)$/i.test(value);
}

function isTokenConfigKey(key: string): boolean {
  return /(^|[-_])(?:auth[-_]?token|access[-_]?token|refresh[-_]?token|id[-_]?token|token)$/i.test(
    normalizeSecretKey(key)
  );
}

function shouldConsumeAuthSchemePair(key: string, firstValue: string): boolean {
  return (isTokenConfigKey(key) || isAuthorizationConfigKey(key)) && isAuthSchemeToken(firstValue);
}

function findAuthSchemeAssignmentIndex(arg: string): number {
  const assignmentIndex = arg.indexOf("=");
  if (assignmentIndex === -1) return -1;
  return shouldConsumeAuthSchemePair(arg.slice(0, assignmentIndex), arg.slice(assignmentIndex + 1))
    ? assignmentIndex
    : -1;
}

function countAuthSchemeContinuationTokens(key: string, argv: string[], startIndex: number): number {
  if (startIndex >= argv.length || isAuthSchemeContinuationBoundary(argv[startIndex]!)) return 0;
  let consumedValues = 1;
  while (
    isAuthorizationConfigKey(key) &&
    startIndex + consumedValues < argv.length &&
    !isAuthSchemeContinuationBoundary(argv[startIndex + consumedValues]!)
  ) {
    consumedValues += 1;
  }
  return consumedValues;
}

function isAuthSchemeContinuationBoundary(arg: string): boolean {
  return isOptionValueBoundaryFlag(arg) || findAuthSchemeAssignmentIndex(arg) !== -1;
}

function countBareSecretValueTokens(key: string, argv: string[], startIndex: number): number {
  if (startIndex >= argv.length || isOptionValueBoundaryFlag(argv[startIndex]!)) return 0;
  const consumeAllValueTokens = isAuthorizationConfigKey(key);
  let consumedValues = 1;
  if (!consumeAllValueTokens && shouldConsumeAuthSchemePair(key, argv[startIndex]!)) {
    return startIndex + 1 < argv.length && !isOptionValueBoundaryFlag(argv[startIndex + 1]!) ? 2 : 1;
  }
  while (
    consumeAllValueTokens &&
    startIndex + consumedValues < argv.length &&
    !isOptionValueBoundaryFlag(argv[startIndex + consumedValues]!)
  ) {
    consumedValues += 1;
  }
  return consumedValues;
}

function normalizeSecretKey(key: string): string {
  let normalized = "";
  for (let index = 0; index < key.length; index += 1) {
    const char = key[index]!;
    if (char === "." || char === "[" || char === "]" || char === ":") {
      normalized += "-";
      continue;
    }
    if (isUppercaseAscii(char)) {
      const previous = key[index - 1];
      const next = key[index + 1];
      if (
        index > 0 &&
        ((previous !== undefined && isLowercaseOrDigitAscii(previous)) ||
          (previous !== undefined && isUppercaseAscii(previous) && next !== undefined && isLowercaseAscii(next)))
      ) {
        normalized += "-";
      }
    }
    normalized += char;
  }
  return normalized;
}

function stripLeadingOptionPrefix(key: string): string {
  let index = 0;
  while (index < key.length && key[index] === "-") index += 1;
  return key.slice(index);
}

function isUppercaseAscii(char: string): boolean {
  return char >= "A" && char <= "Z";
}

function isLowercaseAscii(char: string): boolean {
  return char >= "a" && char <= "z";
}

function isLowercaseOrDigitAscii(char: string): boolean {
  return isLowercaseAscii(char) || (char >= "0" && char <= "9");
}

function isAsciiAlnum(char: string): boolean {
  return isUppercaseAscii(char) || isLowercaseAscii(char) || (char >= "0" && char <= "9");
}

function sanitizeEnvKeys(env: NodeJS.ProcessEnv | undefined, explicitKeys: string[] | undefined): string[] {
  const sourceKeys = explicitKeys ?? Object.keys(env ?? {});
  return [...new Set(sourceKeys)]
    .filter((key) => typeof key === "string" && key.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

function gitOutput(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function buildGitInfo(cwd: string): BenchmarkReproManifest["git"] {
  const commit = gitOutput(["rev-parse", "HEAD"], cwd) || "unknown";
  const shortCommit = gitOutput(["rev-parse", "--short", "HEAD"], cwd) || "unknown";
  const dirtyEntries = gitOutput(["status", "--porcelain", "--untracked-files=all"], cwd)
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  return {
    commit,
    shortCommit,
    dirty: dirtyEntries.length > 0,
    dirtyEntryCount: dirtyEntries.length,
  };
}

function buildArtifactHashIdentity(manifest: Omit<BenchmarkReproManifest, "artifactHash">): unknown {
  return {
    schemaVersion: manifest.schemaVersion,
    run: {
      id: manifest.run.id,
      ...(manifest.run.mode ? { mode: manifest.run.mode } : {}),
      selectedBenchmarks: manifest.run.selectedBenchmarks,
      runtimeProfiles: manifest.run.runtimeProfiles,
      selectedWorkItems: manifest.run.selectedWorkItems,
      ...(manifest.run.limit !== undefined ? { limit: manifest.run.limit } : {}),
      ...(manifest.run.seed !== undefined ? { seed: manifest.run.seed } : {}),
    },
    git: {
      commit: manifest.git.commit,
      shortCommit: manifest.git.shortCommit,
    },
    command: {
      argv: manifest.command.argv,
      envKeys: manifest.command.envKeys,
    },
    environment: {
      platform: manifest.environment.platform,
      arch: manifest.environment.arch,
      nodeVersion: manifest.environment.nodeVersion,
      ...(manifest.environment.packageManager ? { packageManager: manifest.environment.packageManager } : {}),
    },
    ...(manifest.qmd ? { qmd: manifest.qmd } : {}),
    configFiles: manifest.configFiles,
    datasets: manifest.datasets,
    results: manifest.results,
  };
}

async function scanDatasetFiles(root: string): Promise<BenchmarkReproManifestFile[]> {
  const files: BenchmarkReproManifestFile[] = [];

  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const entryStat = await lstat(entryPath);
      const relativePath = path.relative(root, entryPath).split(path.sep).join("/");
      if (entryStat.isSymbolicLink()) {
        const target = await readlink(entryPath);
        const resolvedTarget = path.resolve(directory, target);
        const realTarget = await realpath(resolvedTarget);
        const targetRelativePath = path.relative(root, realTarget);
        if (
          targetRelativePath.length === 0 ||
          targetRelativePath === ".." ||
          targetRelativePath.startsWith(`..${path.sep}`) ||
          path.isAbsolute(targetRelativePath)
        ) {
          throw new Error(`dataset symlink target must be inside ${root}: ${entryPath}`);
        }
        const manifestTarget = path.isAbsolute(target) ? targetRelativePath.split(path.sep).join("/") : target;
        files.push({
          path: relativePath,
          kind: "symlink",
          sizeBytes: Buffer.byteLength(manifestTarget, "utf8"),
          sha256: sha256String(manifestTarget),
          target: manifestTarget,
        });
        continue;
      }
      if (entryStat.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (entryStat.isFile()) {
        files.push({
          path: relativePath,
          kind: "file",
          sizeBytes: entryStat.size,
          sha256: await sha256File(entryPath),
        });
      }
    }
  };

  await walk(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function lstatPathWithoutSymlinkComponents(
  targetPath: string
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  const parsed = path.parse(targetPath);
  const relativePath = path.relative(parsed.root, targetPath);
  const parts = relativePath.length > 0 ? relativePath.split(path.sep) : [];
  let currentPath = parsed.root;
  let currentStat: Awaited<ReturnType<typeof lstat>> | undefined;

  try {
    if (parts.length === 0) {
      currentStat = await lstat(currentPath);
    }
    for (const part of parts) {
      currentPath = path.join(currentPath, part);
      currentStat = await lstat(currentPath);
      if (currentStat.isSymbolicLink()) {
        return undefined;
      }
    }
  } catch {
    return undefined;
  }

  return currentStat;
}

async function buildDatasetManifest(
  benchmark: string,
  datasetDir: string | undefined
): Promise<BenchmarkReproManifestDataset> {
  if (!datasetDir) {
    return {
      benchmark,
      status: "not-provided",
      fileCount: 0,
      totalBytes: 0,
      files: [],
    };
  }

  const datasetRoot = path.resolve(datasetDir);
  const datasetStat = await lstatPathWithoutSymlinkComponents(datasetRoot);
  if (!datasetStat) {
    return {
      benchmark,
      status: "missing",
      path: datasetDir,
      fileCount: 0,
      totalBytes: 0,
      files: [],
    };
  }

  if (!datasetStat.isDirectory()) {
    return {
      benchmark,
      status: "missing",
      path: datasetDir,
      fileCount: 0,
      totalBytes: 0,
      files: [],
    };
  }

  const realDatasetDir = await realpath(datasetRoot);
  const files = await scanDatasetFiles(realDatasetDir);
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  const digest = sha256String(stableStringify(files));
  return {
    benchmark,
    status: "hashed",
    path: datasetDir,
    realpath: realDatasetDir,
    fileCount: files.length,
    totalBytes,
    sha256: digest,
    files,
  };
}

async function buildResultManifest(
  resultsDir: string,
  resultPath: string,
  result: BenchmarkResult
): Promise<BenchmarkReproManifestResult> {
  assertPathInsideRoot(resultsDir, resultPath, "result path");
  await assertRegularFileWithoutSymlinkComponents(resultPath, "result path");
  const fileStats = await stat(resultPath);
  return {
    path: path.relative(resultsDir, resultPath).split(path.sep).join("/"),
    sha256: await sha256File(resultPath),
    sizeBytes: fileStats.size,
    resultId: result.meta.id,
    benchmark: result.meta.benchmark,
    mode: result.meta.mode,
    gitSha: result.meta.gitSha,
    runCount: result.meta.runCount,
    seeds: [...result.meta.seeds],
    taskCount: result.results.tasks.length,
    configHash: sha256String(stableStringify(result.config)),
  };
}

async function resolveResultPaths(resultsDir: string, explicitPaths: string[] | undefined): Promise<string[]> {
  if (explicitPaths !== undefined) {
    const resolvedPaths = await Promise.all(
      explicitPaths.map(async (entry) => {
        const resultPath = path.resolve(entry);
        assertPathInsideRoot(resultsDir, resultPath, "result path");
        await assertRegularFileWithoutSymlinkComponents(resultPath, "result path");
        return resultPath;
      })
    );
    return [...new Set(resolvedPaths)].sort((left, right) => left.localeCompare(right));
  }
  const summaries = await listBenchmarkResults(resultsDir);
  return summaries.map((summary) => path.resolve(summary.path));
}

function assertPathInsideRoot(root: string, targetPath: string, label: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTargetPath = path.resolve(targetPath);
  const relativePath = path.relative(resolvedRoot, resolvedTargetPath);
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(`${label} must be inside ${resolvedRoot}: ${resolvedTargetPath}`);
  }
}

async function assertRegularFileWithoutSymlinkComponents(targetPath: string, label: string): Promise<void> {
  const targetStat = await lstatPathWithoutSymlinkComponents(path.resolve(targetPath));
  if (!targetStat?.isFile()) {
    throw new Error(`${label} must be a regular file without symlink components: ${path.resolve(targetPath)}`);
  }
}

function isKnownNonSecretOptionFlag(arg: string): boolean {
  if (!arg.startsWith("-")) return false;
  return NON_SECRET_ARG_FLAGS.has(getOptionName(arg));
}

function isOptionValueBoundaryFlag(arg: string): boolean {
  if (!arg.startsWith("-")) return false;
  const optionName = getOptionName(arg);
  return (
    BENCH_OPTION_BOUNDARY_FLAGS.has(optionName) ||
    NON_SECRET_ARG_FLAGS.has(optionName) ||
    SECRET_ARG_FLAGS.has(optionName) ||
    (arg.includes("=") && isSecretConfigKey(optionName))
  );
}

function shouldConsumeSeparatedSecretFlagValue(arg: string): boolean {
  return !isOptionValueBoundaryFlag(arg);
}

function getOptionName(arg: string): string {
  return arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
}

function getAttachedShortSecretFlag(arg: string): string | undefined {
  if (arg.includes("=")) return undefined;
  for (const flag of ["-k", "-p", "-t"]) {
    if (arg.startsWith(flag) && arg.length > flag.length) return flag;
  }
  return undefined;
}

function getAttachedLongSecretArg(arg: string): { flag: string; delimiter: "" | "=" } | undefined {
  for (const flag of ATTACHED_LONG_SECRET_ARG_FLAGS) {
    if (arg.startsWith(`${flag}=`) && arg.length > flag.length + 1) {
      return { flag, delimiter: "=" };
    }
    if (arg.startsWith(flag) && arg.length > flag.length && arg[flag.length] !== ":") return { flag, delimiter: "" };
  }
  return undefined;
}

async function buildConfigFileEntries(
  configFiles: BuildBenchmarkReproManifestOptions["configFiles"] = []
): Promise<BenchmarkReproManifest["configFiles"]> {
  const entries: BenchmarkReproManifest["configFiles"] = [];
  for (const configFile of configFiles) {
    if (!configFile.path) {
      continue;
    }
    try {
      const fileStats = await stat(configFile.path);
      if (!fileStats.isFile()) {
        entries.push({ label: configFile.label, path: configFile.path, missing: true });
        continue;
      }
      const content = await readFile(configFile.path);
      const sanitizedConfig = sanitizeConfigFileContent(content);
      entries.push({
        label: configFile.label,
        path: configFile.path,
        sizeBytes: fileStats.size,
        ...(sanitizedConfig.sha256 !== undefined ? { sha256: sanitizedConfig.sha256 } : {}),
        ...(sanitizedConfig.redacted ? { redacted: true } : {}),
      });
    } catch {
      entries.push({ label: configFile.label, path: configFile.path, missing: true });
    }
  }
  return entries;
}

function sanitizeConfigFileContent(content: Buffer): { sha256?: string; redacted: boolean } {
  const text = content.toString("utf8");
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const redacted = redactStructuredSecrets(parsed);
      if (redacted.changed) {
        return { sha256: sha256String(stableStringify(redacted.value)), redacted: true };
      }
    } catch {
      // Fall through to text-pattern detection for malformed config files.
    }
  }
  if (containsSecretConfigText(text)) {
    return { redacted: true };
  }
  return { sha256: sha256Buffer(content), redacted: false };
}

function containsSecretConfigText(text: string): boolean {
  if (sanitizeUrlSecrets(text) !== text) return true;
  const assignmentPattern = /["']?([A-Za-z0-9_.:[\]-]{3,80})["']?\s*[:=]\s*("[^"]+"|'[^']+'|[^\s,;}]+)/g;
  for (const match of text.matchAll(assignmentPattern)) {
    const key = match[1];
    if (key && isSecretConfigKey(key)) return true;
  }
  return false;
}

function collectQmdCollections(explicitCollections: string[] | undefined, results: BenchmarkResult[]): string[] {
  const collections = new Set(explicitCollections ?? []);
  for (const result of results) {
    const config = result.config.remnicConfig ?? {};
    for (const key of ["qmdCollection", "qmdColdCollection", "conversationIndexQmdCollection"]) {
      const value = config[key];
      if (typeof value === "string" && value.trim().length > 0) {
        collections.add(value);
      }
    }
  }
  return [...collections].sort((left, right) => left.localeCompare(right));
}

function resolvePackageManager(cwd: string): string | undefined {
  try {
    return execFileSync("pnpm", ["--version"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

export async function buildBenchmarkReproManifest(
  resultsDir: string,
  options: BuildBenchmarkReproManifestOptions = {}
): Promise<BenchmarkReproManifest> {
  const resolvedResultsDir = path.resolve(resultsDir);
  const cwd = options.command?.cwd ?? process.cwd();
  const resultPaths = await resolveResultPaths(resolvedResultsDir, options.resultPaths);
  const loadedResults = await Promise.all(resultPaths.map((resultPath) => loadBenchmarkResult(resultPath)));
  const resultEntries = await Promise.all(
    resultPaths.map((resultPath, index) => buildResultManifest(resolvedResultsDir, resultPath, loadedResults[index]!))
  );
  const selectedBenchmarks =
    options.selectedBenchmarks ?? [...new Set(loadedResults.map((result) => result.meta.benchmark))].sort();
  const selectedWorkItems =
    options.selectedWorkItems ??
    loadedResults.map((result) => ({
      benchmark: result.meta.benchmark,
      runtimeProfile: result.config.runtimeProfile ?? "unknown",
    }));
  const datasetDirs = options.datasetDirs ?? {};
  const datasets = await Promise.all(
    selectedBenchmarks.map((benchmark) => buildDatasetManifest(benchmark, datasetDirs[benchmark]))
  );
  const qmdCollections = collectQmdCollections(options.qmd?.collections, loadedResults);
  const pnpmVersion = resolvePackageManager(cwd);
  const manifestWithoutHash = {
    schemaVersion: BENCHMARK_REPRO_MANIFEST_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    run: {
      id: options.runId ?? resolveBenchmarkRunId(),
      ...(options.mode ? { mode: options.mode } : {}),
      selectedBenchmarks,
      runtimeProfiles: options.runtimeProfiles ?? [],
      selectedWorkItems,
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
    },
    git: buildGitInfo(cwd),
    command: {
      cwd,
      argv: sanitizeArgv(options.command?.argv ?? process.argv.slice(2)),
      envKeys: sanitizeEnvKeys(options.command?.env, options.command?.envKeys),
    },
    environment: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      hostname: os.hostname(),
      ...(pnpmVersion ? { packageManager: `pnpm@${pnpmVersion}` } : {}),
    },
    ...(options.qmd || qmdCollections.length > 0
      ? {
          qmd: {
            ...(options.qmd?.configDir ? { configDir: options.qmd.configDir } : {}),
            ...(options.qmd?.cacheDir ? { cacheDir: options.qmd.cacheDir } : {}),
            collections: qmdCollections,
          },
        }
      : {}),
    configFiles: await buildConfigFileEntries(options.configFiles),
    datasets,
    results: resultEntries.sort((left, right) => left.path.localeCompare(right.path)),
  };

  return {
    ...manifestWithoutHash,
    artifactHash: sha256String(stableStringify(buildArtifactHashIdentity(manifestWithoutHash))),
  };
}

export async function writeBenchmarkReproManifest(
  resultsDir: string,
  options: BuildBenchmarkReproManifestOptions = {}
): Promise<string> {
  await mkdir(resultsDir, { recursive: true });
  const manifest = await buildBenchmarkReproManifest(resultsDir, options);
  const manifestPath = path.join(resultsDir, BENCHMARK_REPRO_MANIFEST_FILENAME);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}
