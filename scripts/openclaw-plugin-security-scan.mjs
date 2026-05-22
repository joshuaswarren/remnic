#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function usage() {
  return [
    "Usage: node scripts/openclaw-plugin-security-scan.mjs <package-dir>",
    "",
    "Environment:",
    "  OPENCLAW_PACKAGE_DIR  Path to an installed openclaw package directory.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = argv.slice(2).filter((arg) => arg !== "--");
  const packageDir = args[0];
  if (!packageDir || packageDir === "--help" || packageDir === "-h") {
    console.error(usage());
    process.exit(packageDir ? 0 : 2);
  }
  return resolveUserPath(packageDir);
}

function findOpenClawPackageDir() {
  const explicit = process.env.OPENCLAW_PACKAGE_DIR;
  if (explicit) return resolveUserPath(explicit);

  for (const searchRoot of [
    process.cwd(),
    path.join(process.cwd(), "node_modules"),
    "/opt/homebrew/lib/node_modules",
    "/usr/local/lib/node_modules",
  ]) {
    const candidate = searchRoot.endsWith("openclaw")
      ? searchRoot
      : path.join(searchRoot, "openclaw");
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
  }

  throw new Error("Unable to find openclaw package; set OPENCLAW_PACKAGE_DIR.");
}

function expandTilde(input) {
  if (input === "~") return process.env.HOME || os.homedir();
  if (input.startsWith("~/")) {
    return path.join(process.env.HOME || os.homedir(), input.slice(2));
  }
  return input;
}

function resolveUserPath(input) {
  return path.resolve(expandTilde(input));
}

function findScannerModule(openclawPackageDir) {
  const distDir = path.join(openclawPackageDir, "dist");
  if (!fs.existsSync(distDir)) {
    throw new Error(`OpenClaw dist directory not found: ${distDir}`);
  }

  const candidates = fs.readdirSync(distDir)
    .filter((entry) => /^(?:skill-)?scanner-.*\.js$/.test(entry))
    .sort()
    .map((entry) => path.join(distDir, entry));

  if (candidates.length === 0) {
    throw new Error(`OpenClaw scanner module not found under ${distDir}`);
  }

  return candidates[0];
}

function selectScannerFunction(moduleExports) {
  const exportedFunctions = Object.entries(moduleExports)
    .filter(([, value]) => typeof value === "function");
  const byExportName = (name) => exportedFunctions.find(([exportName]) => exportName === name)?.[1];
  const byFunctionName = (name) => exportedFunctions.find(([, value]) => value.name === name)?.[1];

  if (typeof moduleExports.scanDirectoryWithSummary === "function") {
    return moduleExports.scanDirectoryWithSummary;
  }

  const namedSummaryScanner = byFunctionName("scanDirectoryWithSummary");
  if (namedSummaryScanner) return namedSummaryScanner;

  if (typeof moduleExports.scanDirectory === "function") {
    return moduleExports.scanDirectory;
  }

  const namedDirectoryScanner = byFunctionName("scanDirectory");
  if (namedDirectoryScanner) return namedDirectoryScanner;

  const legacyMinifiedScanner = byExportName("t");
  if (
    legacyMinifiedScanner &&
    legacyMinifiedScanner.name !== "clearSkillScanCacheForTest" &&
    legacyMinifiedScanner.length > 0
  ) {
    return legacyMinifiedScanner;
  }

  if (exportedFunctions.length === 1) return exportedFunctions[0][1];

  throw new Error(
    `Unable to identify OpenClaw scanner export; found exports: ${Object.keys(moduleExports).join(", ")}`,
  );
}

function normalizeScanSummary(rawSummary, scannerName) {
  const countSeverity = (findings, severity) =>
    findings.filter((finding) => finding?.severity === severity).length;

  if (Array.isArray(rawSummary)) {
    return {
      scannedFiles: "unknown",
      critical: countSeverity(rawSummary, "critical"),
      warn: countSeverity(rawSummary, "warn"),
      findings: rawSummary,
    };
  }

  if (!rawSummary || typeof rawSummary !== "object") {
    throw new Error(
      `OpenClaw scanner ${scannerName || "unknown"} returned ${rawSummary === null ? "null" : typeof rawSummary}; expected a scan summary.`,
    );
  }

  const findings = Array.isArray(rawSummary.findings) ? rawSummary.findings : [];
  return {
    scannedFiles: rawSummary.scannedFiles ?? "unknown",
    critical: typeof rawSummary.critical === "number"
      ? rawSummary.critical
      : countSeverity(findings, "critical"),
    warn: typeof rawSummary.warn === "number" ? rawSummary.warn : countSeverity(findings, "warn"),
    findings,
  };
}

function formatFinding(finding) {
  const severity = finding.severity ?? "unknown";
  const message = finding.message ?? "finding";
  const file = finding.file ?? "unknown";
  const line = finding.line ?? 1;
  const evidence = finding.evidence ? ` ${finding.evidence}` : "";
  return `${severity}\t${message}\t${file}:${line}${evidence}`;
}

const packageDir = parseArgs(process.argv);
if (!fs.existsSync(packageDir) || !fs.statSync(packageDir).isDirectory()) {
  throw new Error(`Package directory does not exist or is not a directory: ${packageDir}`);
}

const openclawPackageDir = findOpenClawPackageDir();
const openclawPackageJson = JSON.parse(fs.readFileSync(path.join(openclawPackageDir, "package.json"), "utf8"));
const scannerModule = findScannerModule(openclawPackageDir);
const scannerExports = await import(pathToFileURL(scannerModule).href);
const scan = selectScannerFunction(scannerExports);
const summary = normalizeScanSummary(await scan(packageDir), scan.name);
const findings = summary.findings;

console.log(`OpenClaw ${openclawPackageJson.version} scanner: ${scannerModule}`);
for (const finding of findings) console.log(formatFinding(finding));
console.log(`scanned=${summary.scannedFiles ?? "unknown"} critical=${summary.critical ?? 0} warn=${summary.warn ?? 0}`);

if ((summary.critical ?? 0) > 0) {
  process.exitCode = 1;
}
