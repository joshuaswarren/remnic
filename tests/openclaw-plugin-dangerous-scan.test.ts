import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const PLUGIN_DIR = path.join(ROOT, "packages", "plugin-openclaw");

const SCANNABLE_EXTENSIONS = new Set([
  ".js",
  ".ts",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".jsx",
  ".tsx",
]);
const MAX_SCAN_FILES = 500;
const NETWORK_SEND_CONTEXT_PATTERN = /\bfetch\s*\(|\bpost\s*\(|\.\s*post\s*\(|http\.request\s*\(/i;

const CRITICAL_LINE_RULES = [
  {
    message: "Shell command execution detected (child_process)",
    pattern: /\b(exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\(/,
    requiresContext: /child_process/,
  },
  {
    message: "Dynamic code execution detected",
    pattern: /\beval\s*\(|new\s+Function\s*\(/,
  },
  {
    message: "Possible crypto-mining reference detected",
    pattern: /stratum\+tcp|stratum\+ssl|coinhive|cryptonight|xmrig/i,
  },
];

const CRITICAL_SOURCE_RULES = [
  {
    message: "Environment variable access combined with network send - possible credential harvesting",
    pattern: /process\.env/,
    requiresContext: NETWORK_SEND_CONTEXT_PATTERN,
  },
];

interface Finding {
  message: string;
  file: string;
  line: number;
  evidence: string;
}

function isScannable(filePath: string): boolean {
  return SCANNABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function collectScannableFiles(rootDir: string): string[] {
  const files: string[] = [];
  const stack = [rootDir];

  while (stack.length > 0 && files.length < MAX_SCAN_FILES) {
    const currentDir = stack.pop();
    if (!currentDir) break;

    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      if (files.length >= MAX_SCAN_FILES) break;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && isScannable(fullPath)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function scanSource(source: string, filePath: string): Finding[] {
  const findings: Finding[] = [];
  const lines = source.split("\n");

  for (const rule of CRITICAL_LINE_RULES) {
    if (rule.requiresContext && !rule.requiresContext.test(source)) continue;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!rule.pattern.test(line)) continue;
      findings.push({
        message: rule.message,
        file: path.relative(ROOT, filePath),
        line: i + 1,
        evidence: line.trim().slice(0, 120),
      });
      break;
    }
  }

  for (const rule of CRITICAL_SOURCE_RULES) {
    if (!rule.pattern.test(source)) continue;
    if (rule.requiresContext && !rule.requiresContext.test(source)) continue;
    const lineIndex = lines.findIndex((line) => rule.pattern.test(line));
    findings.push({
      message: rule.message,
      file: path.relative(ROOT, filePath),
      line: lineIndex >= 0 ? lineIndex + 1 : 1,
      evidence: (lineIndex >= 0 ? lines[lineIndex] : source).trim().slice(0, 120),
    });
  }

  return findings;
}

function scanOpenClawCriticalFindings(rootDir: string): Finding[] {
  const findings: Finding[] = [];

  for (const file of collectScannableFiles(rootDir)) {
    findings.push(...scanSource(fs.readFileSync(file, "utf8"), file));
  }

  return findings;
}

test("@remnic/plugin-openclaw package has no OpenClaw dangerous-code critical findings", () => {
  const build = spawnSync(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["--filter", "@remnic/plugin-openclaw", "build"],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  );

  assert.equal(
    build.status,
    0,
    `plugin build failed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
  );

  const findings = scanOpenClawCriticalFindings(PLUGIN_DIR);
  assert.deepEqual(
    findings,
    [],
    `OpenClaw dangerous-code critical findings:\n${findings
      .map((finding) => `${finding.message} (${finding.file}:${finding.line}) ${finding.evidence}`)
      .join("\n")}`,
  );
});
