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
export function parseQmdStatusOutput(stdout: string): QmdStatusReport {
  const raw = stdout;
  let totalFiles: number | null = null;
  let embeddedFiles: number | null = null;
  let pendingEmbeddings: number | null = null;
  let oldestPendingAgeMs: number | null = null;

  const totalMatch = stdout.match(/total\s+files?\s*:?\s*(\d[\d,]*)/i);
  if (totalMatch) totalFiles = Number.parseInt(totalMatch[1].replace(/,/g, ""), 10);

  const embeddedMatch = stdout.match(/embedded\s*:?\s*(\d[\d,]*)/i);
  if (embeddedMatch) embeddedFiles = Number.parseInt(embeddedMatch[1].replace(/,/g, ""), 10);

  const pendingMatch = stdout.match(/pending\s*(?:embedding|embed|files?)?\s*:?\s*(\d[\d,]*)/i)
    ?? stdout.match(/pending\s+(\d[\d,]*)/i);
  if (pendingMatch) pendingEmbeddings = Number.parseInt(pendingMatch[1].replace(/,/g, ""), 10);

  // Some QMD versions report oldest pending age directly
  const oldestMatch = stdout.match(/oldest\s+pending\s*:?\s*(\d+)\s*(ms|s|m|h)/i);
  if (oldestMatch) {
    const val = Number.parseInt(oldestMatch[1], 10);
    const unit = oldestMatch[2].toLowerCase();
    oldestPendingAgeMs = unit === "ms" ? val : unit === "s" ? val * 1000 : unit === "m" ? val * 60_000 : val * 3_600_000;
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
    if (report.pendingEmbeddings > threshold) {
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
    const report = await backend.status();
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
 * Embed specific files via `qmd embed --files`. Returns `{ ok: false }`
 * on failure so callers can handle errors without throwing.
 */
export async function embedQmdFiles(
  runQmdCommand: QmdCommandRunner,
  collection: string,
  filePaths: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; error?: string }> {
  if (filePaths.length === 0) return { ok: true };
  try {
    await runQmdCommand(["embed", "-c", collection, "--files", ...filePaths], timeoutMs);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
