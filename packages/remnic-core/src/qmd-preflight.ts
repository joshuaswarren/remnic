/**
 * QMD version-check PREFLIGHT / probe-classification helpers.
 *
 * Pure, self-contained functions extracted from qmd.ts (issue #1841) so the
 * QmdClient class file stays under the structural-ratchet LOC ceiling. These
 * cover two related concerns of the startup preflight:
 *
 * 1. VERSION parsing/comparison — turning `qmd --version` output into a tuple,
 *    comparing against the supported target, and resolving feature capability
 *    flags from the parsed version.
 * 2. PROBE failure classification — distinguishing a slow/overloaded binary
 *    (transient → retry) from a genuine misconfiguration (ENOENT/EACCES → fail
 *    fast) using STRUCTURED signals, never the error message.
 *
 * No behavioral change from qmd.ts round 1 (issue #1841): structured-signal
 * classification (code=ENOENT/EACCES=>missing, timedOut flag=>transient,
 * caller-cancel silenced, non-zero-exit=>other); backoff [300,800].
 */
import { isAbortError } from "./abort-error.js";
import type { QmdCapabilities, QmdVersionTuple } from "./qmd.js";

// Deadline (ms) for a single `qmd --version` probe.
export const QMD_PROBE_TIMEOUT_MS = 8_000;

// Backoff schedule (ms) for retrying a TRANSIENT (timeout/abort) version-check
// probe of a CONFIGURED qmdPath before declaring it failed. A binary that
// resolved and ran before is more likely slow under load than gone, so we retry
// transient failures but NOT ENOENT/EACCES (hard misconfiguration, fail fast).
// Length == number of retries after the initial attempt. Issue #1841.
export const QMD_PROBE_RETRY_BACKOFF_MS = [300, 800];

export const QMD_SUPPORTED_VERSION = "2.5.3";

/**
 * Classify a `qmd --version` probe failure so the preflight can distinguish a
 * slow/overloaded binary (a genuine deadline timeout) from a real
 * misconfiguration (ENOENT/EACCES — the configured path is missing or not
 * executable). Only transient failures are retried; missing binaries fail fast.
 *
 * Classification keys on STRUCTURED signals, never the error *message*: a
 * non-zero-exit failure embeds the child's stderr in its message, so scanning
 * that text for "abort"/"timed out"/"not found" would misclassify a healthy
 * binary. The structured signals are: `code` (ENOENT/EACCES) for missing; the
 * `timedOut` flag set by `runCommandWithTimeout` for a genuine timeout; an
 * AbortError name for a deadline/abort under load. Issue #1841.
 */
export type QmdProbeFailureKind = "transient" | "missing" | "other";
export function classifyProbeFailure(err: unknown): QmdProbeFailureKind {
  if (err && typeof err === "object") {
    // Node spawn failures carry a structured `code`: ENOENT (not found) /
    // EACCES (not executable).
    if ("code" in err) {
      const code = err.code;
      if (code === "ENOENT" || code === "EACCES") return "missing";
    }
    // runCommandWithTimeout flags a genuine deadline breach with `timedOut`.
    if ("timedOut" in err && err.timedOut === true) return "transient";
  }
  // An AbortError reaching here is a deadline/abort under load → transient.
  // (Caller cancellation is intercepted by the retry loop before this runs.)
  if (isAbortError(err)) return "transient";
  // Anything else — including a non-zero exit whose message embeds stderr — is
  // a generic failure: never scan the message to upgrade/downgrade it.
  return "other";
}

export function parseQmdVersion(version: string | null): QmdVersionTuple | null {
  if (!version) return null;
  const match = version.match(/v?(\d{1,10})\.(\d{1,10})\.(\d{1,10})/i);
  if (!match) return null;
  return [
    Number.parseInt(match[1] ?? "0", 10),
    Number.parseInt(match[2] ?? "0", 10),
    Number.parseInt(match[3] ?? "0", 10),
  ];
}

export function parseQmdVersionOutput(stdout: string, stderr: string): string | null {
  const lines = `${stdout}\n${stderr}`
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (lines.length === 0) return null;
  const semanticLines = lines.filter((line) => parseQmdVersion(line) !== null);
  if (semanticLines.length === 0) return lines[0] ?? null;
  return semanticLines.find((line) => /\bqmd\b/i.test(line)) ?? semanticLines[0] ?? null;
}

export function compareQmdVersions(left: QmdVersionTuple | null, right: QmdVersionTuple | null): number {
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  for (let i = 0; i < 3; i += 1) {
    if ((left[i] ?? 0) > (right[i] ?? 0)) return 1;
    if ((left[i] ?? 0) < (right[i] ?? 0)) return -1;
  }
  return 0;
}

export function versionAtLeast(current: QmdVersionTuple | null, target: QmdVersionTuple): boolean {
  return compareQmdVersions(current, target) >= 0;
}

export function resolveQmdCapabilities(version: string | null): QmdCapabilities {
  const parsedVersion = parseQmdVersion(version);
  const atLeast = (target: QmdVersionTuple): boolean => versionAtLeast(parsedVersion, target);
  return {
    version,
    parsedVersion,
    stableSdk: atLeast([2, 0, 0]),
    unifiedSearch: atLeast([2, 0, 0]),
    getDocumentBody: atLeast([2, 0, 0]),
    maintenanceApi: atLeast([2, 0, 0]),
    legacySkillInstall: atLeast([2, 0, 1]),
    intentHints: atLeast([1, 1, 5]),
    explainTraces: atLeast([1, 1, 2]),
    candidateLimit: atLeast([1, 1, 2]),
    v2McpQueryTool: atLeast([2, 0, 0]),
    structuredSearches: atLeast([2, 0, 0]),
    queryRerankToggle: atLeast([2, 1, 0]),
    chunkStrategy: atLeast([2, 1, 0]),
    qmdBench: atLeast([2, 1, 0]),
    perCollectionModels: atLeast([2, 1, 0]),
    jsonLineNumbers: atLeast([2, 1, 0]),
    editorLinks: atLeast([2, 1, 0]),
    doctor: atLeast([2, 5, 0]),
    versionedSkills: atLeast([2, 5, 0]),
    absoluteSnippetLines: atLeast([2, 5, 0]),
    fullQueryOutput: atLeast([2, 5, 0]),
    forceCpu: atLeast([2, 5, 0]),
    gpuBackendOverride: atLeast([2, 5, 0]),
    embedParallelism: atLeast([2, 5, 0]),
    modelEnvConsistency: atLeast([2, 5, 0]),
    scopedEmbed: atLeast([2, 5, 0]),
    safeStatusDeviceProbe: atLeast([2, 5, 0]),
    mcpIndexSelection: atLeast([2, 5, 0]),
    outputFormatFlag: atLeast([2, 5, 3]),
  };
}

export function shouldAutoUpgradeQmd(
  installedVersion: string | null,
  supportedVersion: string = QMD_SUPPORTED_VERSION
): boolean {
  const installed = parseQmdVersion(installedVersion);
  const supported = parseQmdVersion(supportedVersion);
  if (!installed || !supported) return false;
  return compareQmdVersions(installed, supported) < 0;
}

export function getQmdPostInstallProbeTargets(
  qmdPath: string,
  qmdPathSource: "configured" | "auto-path" | "auto-fallback"
): Array<{ qmdPath: string; source: "auto-path" | "auto-fallback" }> {
  const targets: Array<{ qmdPath: string; source: "auto-path" | "auto-fallback" }> = [
    { qmdPath: "qmd", source: "auto-path" },
  ];
  const normalizedPath = qmdPath.trim();
  if (qmdPathSource === "auto-fallback" && normalizedPath.length > 0 && normalizedPath !== "qmd") {
    targets.push({ qmdPath: normalizedPath, source: "auto-fallback" });
  }
  return targets;
}

export function qmdVersionToString(version: QmdVersionTuple): string {
  return `${version[0]}.${version[1]}.${version[2]}`;
}
