/**
 * QMD status parsing and backlog reporting helpers.
 *
 * Extracted from qmd.ts to keep that module under its structural ceiling.
 * Issue #2019: expose embedding backlog metrics in health and CLI surfaces.
 */

export interface QmdStatusReport {
  totalFiles: number | null;
  embeddedFiles: number | null;
  pendingEmbeddings: number | null;
  /** Age in ms of the oldest file still pending embedding, or null if unavailable. */
  oldestPendingAgeMs: number | null;
  /** Raw text output from `qmd status` for debugging. */
  raw: string;
  /** Error message when the status command fails, if any. */
  error?: string;
}

/** Minimal interface for backends that expose QMD status. */
export interface QmdStatusCapable {
  status(): Promise<QmdStatusReport>;
}

/**
 * Parse `qmd status -c <collection>` text output into structured metrics.
 * Handles formats like:
 *   Total files: 200129
 *   Embedded: 189091 (94.5%)
 *   Pending embedding: 108186
 * Returns null fields for unparseable or missing lines.
 */
function parseLeadingInt(s: string): number | null {
  let digits = "";
  for (const ch of s) {
    if (ch >= "0" && ch <= "9") digits += ch;
    else if (ch === "," && digits.length > 0) continue;
    else break;
  }
  return digits.length > 0 ? Number.parseInt(digits, 10) : null;
}

function parseLeadingDurationMs(s: string): number | null {
  let digits = "";
  let i = 0;
  for (; i < s.length; i++) {
    if (s[i] >= "0" && s[i] <= "9") digits += s[i];
    else break;
  }
  if (digits.length === 0) return null;
  const val = Number.parseInt(digits, 10);
  const unit = s.slice(i).trim();
  if (unit === "ms") return val;
  if (unit === "s") return val * 1000;
  if (unit === "m") return val * 60_000;
  if (unit === "h") return val * 3_600_000;
  return null;
}

export function parseQmdStatusOutput(stdout: string): QmdStatusReport {
  const raw = stdout;
  let totalFiles: number | null = null;
  let embeddedFiles: number | null = null;
  let pendingEmbeddings: number | null = null;
  let oldestPendingAgeMs: number | null = null;

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim().toLowerCase();
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();

    if (key === "total" || key === "total files" || key === "total file") {
      totalFiles = parseLeadingInt(value);
    } else if (key === "vectors" || key === "embedded") {
      embeddedFiles = parseLeadingInt(value);
    } else if (key === "oldest pending") {
      oldestPendingAgeMs = parseLeadingDurationMs(value);
    } else if (key.startsWith("pending")) {
      pendingEmbeddings = parseLeadingInt(value);
    }
  }

  return { totalFiles, embeddedFiles, pendingEmbeddings, oldestPendingAgeMs, raw };
}

/** Empty status report returned when QMD is unavailable or the command fails. */
export const EMPTY_QMD_STATUS: QmdStatusReport = {
  totalFiles: null,
  embeddedFiles: null,
  pendingEmbeddings: null,
  oldestPendingAgeMs: null,
  raw: "",
};

/**
 * Format backlog lines from a pre-resolved status report.
 * Returns display strings for CLI output; empty array when unavailable.
 */
export function formatBacklogLinesFromReport(
  report: QmdStatusReport | null | undefined,
  threshold: number,
): string[] {
  if (!report) return [];
  const lines: string[] = [];

  if (report.pendingEmbeddings != null) {
    lines.push(`  Pending embeddings: ${report.pendingEmbeddings}`);
    if (threshold > 0 && report.pendingEmbeddings > threshold) {
      lines.push(`  ⚠ Embedding backlog exceeds threshold (${threshold}) — degraded`);
    }
  }

  if (report.oldestPendingAgeMs != null) {
    const ageMin = Math.round(report.oldestPendingAgeMs / 60_000);
    lines.push(`  Oldest pending: ${ageMin}m`);
  }

  return lines;
}

/**
 * Fetch QMD status and format backlog lines for CLI output.
 * Returns empty array when the backend lacks status() or the call fails.
 */
export async function renderQmdBacklogStatus(
  qmd: unknown,
  threshold: number,
): Promise<string[]> {
  const backend = qmd as Partial<QmdStatusCapable> | null;
  if (!backend || typeof backend.status !== "function") return [];
  try {
    const report = await Promise.race([
      backend.status(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000).unref?.()),
    ]);
    if (!report) return [];
    return formatBacklogLinesFromReport(report, threshold);
  } catch {
    return [];
  }
}

export type QmdCommandRunner = (args: string[], timeoutMs: number) => Promise<{ stdout: string; stderr: string }>;

/**
 * Fetch QMD collection status via the `qmd status` command. Returns an
 * unavailable report (with `error` set) when the command fails.
 */
export async function fetchQmdStatus(
  runQmdCommand: QmdCommandRunner,
  collection: string,
  timeoutMs: number,
): Promise<QmdStatusReport> {
  try {
    const { stdout } = await runQmdCommand(["status", "-c", collection], timeoutMs);
    return parseQmdStatusOutput(stdout);
  } catch (error) {
    return { ...EMPTY_QMD_STATUS, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Trigger a collection-level embed run via `qmd embed -c <collection>`.
 * The QMD CLI does not support per-file embed targeting; this triggers
 * embedding for all pending files in the collection. The prioritized-embed
 * module debounces and batches these triggers so fresh writes become
 * searchable within minutes without hammering the CLI on every write.
 * Returns `{ ok: false }` on failure so callers can reschedule without crashing.
 */
export async function embedQmdFiles(
  runQmdCommand: QmdCommandRunner,
  collection: string,
  _filePaths: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await runQmdCommand(["update", "-c", collection], timeoutMs);
    await runQmdCommand(["embed", "-c", collection], timeoutMs);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
