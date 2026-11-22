import { isAbortError } from "./abort-error.js";
import type { QmdCapabilities, QmdVersionTuple } from "./qmd.js";

export const QMD_PROBE_TIMEOUT_MS = 8_000;

export const QMD_PROBE_RETRY_BACKOFF_MS = [300, 800];

export const QMD_SUPPORTED_VERSION = "2.8.3";

export type QmdProbeFailureKind = "transient" | "missing" | "other";
export function classifyProbeFailure(err: unknown): QmdProbeFailureKind {
  if (err && typeof err === "object") {
    if ("code" in err) {
      const code = err.code;
      if (code === "ENOENT" || code === "EACCES") return "missing";
    }
    if ("timedOut" in err && err.timedOut === true) return "transient";
  }
  if (isAbortError(err)) return "transient";
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

/** First QMD release that needs the pinned, patched build (docs/qmd-2.8.3.md); stock npm lacks the patches. */
const QMD_PATCHED_BUILD_MIN: QmdVersionTuple = [2, 8, 3];

/** False when `npm install -g @tobilu/qmd@<supported>` would install stock QMD instead of the patched build. */
export function autoUpgradeInstallsStockPackage(supportedVersion: string): boolean {
  const supported = parseQmdVersion(supportedVersion);
  return supported !== null && compareQmdVersions(supported, QMD_PATCHED_BUILD_MIN) < 0;
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
