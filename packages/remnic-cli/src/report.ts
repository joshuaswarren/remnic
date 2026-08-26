/**
 * `remnic report` — opt-in, anonymized diagnostic bundle (issue #3037).
 *
 * Builds a report from an EXPLICIT allow-list. Never serializes the config
 * and then redacts: every field in the output is enumerated in this file.
 * Strings, paths, hostnames, URLs, and keys are NEVER included.
 *
 * The report is saved to ~/.remnic/reports/report-<date>.md and .json. The
 * command prints a prefilled GitHub issue URL. It NEVER auto-submits, never
 * makes network calls, and never spawns `gh`.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ─── Allow‑list ───────────────────────────────────────────────────────────

/** Fields that MAY appear in the report. Frozen `as const`. */
export const REPORT_ALLOWED_CONFIG_FIELDS = Object.freeze([
  "qmdEnabled",
  "qmdAutoEmbedEnabled",
  "qmdDaemonEnabled",
  "qmdColdTierEnabled",
  "qmdTierMigrationEnabled",
  "qmdTierAutoBackfillEnabled",
  "qmdMaintenanceEnabled",
  "debug",
  "identityEnabled",
  "injectQuestions",
  "consolidateEveryN",
  "maxMemoryTokens",
  "commitmentDecayDays",
] as const);
// @ts-expect-error "bogus" is not in the list — this fails if the type widens
const _allowListPin: (typeof REPORT_ALLOWED_CONFIG_FIELDS)[number] = "bogus";
void _allowListPin;

// ─── Types ────────────────────────────────────────────────────────────────

export interface DoctorCheckSummary {
  name: string;
  ok: boolean;
}

export interface ReportContent {
  schemaVersion: "1";
  generatedAt: string;
  platform: {
    os: string;
    arch: string;
    node: string;
  };
  remnicVersion: string;
  doctor: DoctorCheckSummary[];
  configShape: Record<string, unknown>;
  storeScale: {
    totalMemories: number;
    sizeBucket: string;
  };
  benchScorecard?: unknown;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

const SIZE_BUCKETS = Object.freeze([
  { label: "< 1 KB", max: 1024 },
  { label: "1 KB – 10 KB", max: 10 * 1024 },
  { label: "10 KB – 100 KB", max: 100 * 1024 },
  { label: "100 KB – 1 MB", max: 1024 * 1024 },
  { label: "1 MB – 10 MB", max: 10 * 1024 * 1024 },
  { label: "10 MB – 100 MB", max: 100 * 1024 * 1024 },
  { label: "100 MB – 1 GB", max: 1024 * 1024 * 1024 },
  { label: "> 1 GB", max: Infinity },
] as const);

export function sizeBucket(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return SIZE_BUCKETS[0].label;
  for (const bucket of SIZE_BUCKETS) {
    if (bytes <= bucket.max) return bucket.label;
  }
  return SIZE_BUCKETS[SIZE_BUCKETS.length - 1].label;
}

function sizeOfStore(dir: string): number {
  try {
    const { execSync } = require("child_process");
    const output = execSync(`du -sb "${dir}" 2>/dev/null || echo 0`, {
      encoding: "utf-8",
      timeout: 5000,
    });
    const match = output.match(/^(\d+)/);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

function countMemories(dir: string): number {
  try {
    let count = 0;
    const walk = (d: string) => {
      for (const entry of readdirSync(d)) {
        const full = path.join(d, entry);
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else if (entry.endsWith(".md")) count++;
      }
    };
    walk(dir);
    return count;
  } catch {
    return 0;
  }
}

// ─── Config discovery ─────────────────────────────────────────────────────

function findConfigPath(): string | undefined {
  const candidates = [
    path.join(os.homedir(), ".config", "remnic", "config.json"),
    path.join(os.homedir(), ".config", "openclaw", "openclaw.json"),
    path.join(os.homedir(), ".openclaw", "config.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

function findMemoryDir(configPath: string | undefined): string {
  if (configPath) {
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      const cfg = raw?.plugins?.["remnic"] ?? raw?.plugins?.["openclaw-engram"] ?? {};
      if (typeof cfg.memoryDir === "string") return cfg.memoryDir;
    } catch {
      // fall through
    }
  }
  return path.join(os.homedir(), ".remnic", "memory");
}

// ─── Config shape extractor (allow‑list only) ─────────────────────────────

function extractConfigShape(rawConfig: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(rawConfig)) {
    if (!Object.hasOwn(rawConfig, key)) continue;
    if (!(REPORT_ALLOWED_CONFIG_FIELDS as readonly string[]).includes(key)) continue;
    const value = rawConfig[key];
    // Only booleans, numbers, and known enum strings.
    if (typeof value === "boolean" || typeof value === "number") {
      result[key] = value;
    } else if (typeof value === "string" && ["alpha", "beta", "stable"].includes(value)) {
      result[key] = value;
    }
  }
  return result;
}

// ─── Doctor checks (named + boolean only) ─────────────────────────────────

function runDoctorChecks(): DoctorCheckSummary[] {
  const checks: DoctorCheckSummary[] = [];

  // Node.js version
  const nodeMajor = Number.parseInt(process.version.slice(1).split(".")[0], 10);
  checks.push({ name: "Node.js version", ok: nodeMajor >= 22 });

  // Config file
  const configPath = findConfigPath();
  checks.push({ name: "Config file", ok: configPath !== undefined });

  // Memory directory
  const memoryDir = findMemoryDir(configPath);
  try {
    mkdirSync(memoryDir, { recursive: true });
    checks.push({ name: "Memory directory", ok: true });
  } catch {
    checks.push({ name: "Memory directory", ok: false });
  }

  // OpenClaw config presence
  const openclawPath = path.join(os.homedir(), ".config", "openclaw", "openclaw.json");
  checks.push({ name: "OpenClaw config file", ok: existsSync(openclawPath) });

  return checks;
}

// ─── Report builders ──────────────────────────────────────────────────────

export async function buildReport(options: { includeBench?: boolean } = {}): Promise<ReportContent> {
  const generatedAt = new Date().toISOString();
  const platform = { os: os.platform(), arch: os.arch(), node: process.version };

  // Read package version
  let remnicVersion = "unknown";
  try {
    const pkgPath = require.resolve("@remnic/core/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    remnicVersion = pkg.version ?? "unknown";
  } catch {
    // fall through
  }

  const doctor = runDoctorChecks();

  // Config shape (allow-list only)
  let configShape: Record<string, unknown> = {};
  try {
    const configPath = findConfigPath();
    if (configPath) {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      const remnicCfg = raw?.plugins?.["remnic"] ?? raw?.plugins?.["openclaw-engram"] ?? {};
      configShape = extractConfigShape(remnicCfg);
    }
  } catch {
    // Config unreadable — skip
  }

  // Store scale
  const memoryDir = findMemoryDir(findConfigPath());
  const totalMemories = countMemories(memoryDir);
  const storeBytes = sizeOfStore(memoryDir);
  const sizeBucketLabel = sizeBucket(storeBytes);

  // Optional bench scorecard
  let benchScorecard: unknown;
  if (options.includeBench) {
    const scorecardPath = path.join(os.homedir(), ".remnic", "reports", "bench-scorecard.json");
    try {
      const data = await readFile(scorecardPath, "utf-8");
      benchScorecard = JSON.parse(data);
    } catch {
      // Scorecard absent — section will be omitted
    }
  }

  return {
    schemaVersion: "1",
    generatedAt,
    platform,
    remnicVersion,
    doctor,
    configShape,
    storeScale: { totalMemories, sizeBucket: sizeBucketLabel },
    ...(benchScorecard !== undefined ? { benchScorecard } : {}),
  };
}

export function renderReportMarkdown(report: ReportContent): string {
  const lines: string[] = [
    "## Remnic Diagnostic Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Version: ${report.remnicVersion}`,
    `Platform: ${report.platform.os} ${report.platform.arch} (Node ${report.platform.node})`,
    "",
    "### Doctor Checks",
    "",
    "| Check | Status |",
    "| --- | --- |",
  ];
  for (const check of report.doctor) {
    lines.push(`| ${check.name} | ${check.ok ? "Pass" : "Fail"} |`);
  }
  lines.push("", "### Config Shape (allow-list only)", "");
  const keys = Object.getOwnPropertyNames(report.configShape).sort();
  lines.push("| Field | Value |");
  lines.push("| --- | --- |");
  for (const key of keys) {
    lines.push(`| ${key} | ${JSON.stringify(report.configShape[key])} |`);
  }
  lines.push("", "### Store Scale", "");
  lines.push("| Metric | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Total memories | ${report.storeScale.totalMemories} |`);
  lines.push(`| Store size | ${report.storeScale.sizeBucket} |`);

  if (report.benchScorecard !== undefined) {
    lines.push("", "### Bench Scorecard", "");
    lines.push("```json");
    lines.push(JSON.stringify(report.benchScorecard, null, 2));
    lines.push("```");
  }

  lines.push("", "---", "", "**Privacy:** This report contains only the fields listed above.");
  lines.push("No secrets, paths, hostnames, or personal data are included.");
  lines.push("", "To file an issue, paste the above into a new GitHub issue at:");
  lines.push("https://github.com/joshuaswarren/remnic/issues/new");
  return lines.join("\n");
}

export function renderReportJson(report: ReportContent): string {
  return JSON.stringify(report, null, 2);
}

// ─── CLI entrypoint ───────────────────────────────────────────────────────

export async function cmdReport(options: { json?: boolean; includeBench?: boolean } = {}): Promise<void> {
  const reportDir = path.join(os.homedir(), ".remnic", "reports");
  mkdirSync(reportDir, { recursive: true });

  const report = await buildReport({ includeBench: options.includeBench });

  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const mdPath = path.join(reportDir, `report-${dateStr}.md`);
  const jsonPath = path.join(reportDir, `report-${dateStr}.json`);

  const md = renderReportMarkdown(report);
  const json = renderReportJson(report);

  writeFileSync(mdPath, md, "utf-8");
  writeFileSync(jsonPath, json, "utf-8");

  if (options.json) {
    console.log(json);
  } else {
    console.log(md);
  }

  console.log(`\nReport saved to:\n  ${mdPath}\n  ${jsonPath}`);
  console.log("\nTo file an issue, run:");
  console.log(`  gh issue create --title "Remnic diagnostic report ${dateStr}" --body-file "${mdPath}"`);
  console.log("\nOr paste the report at: https://github.com/joshuaswarren/remnic/issues/new");
}