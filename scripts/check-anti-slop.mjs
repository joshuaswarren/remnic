#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseAddedLines } from "./check-regex-safety.mjs";

const require = createRequire(import.meta.url);
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const git = (...args) => execFileSync("git", ["-c", "core.quotePath=false", ...args], {
  cwd: root, encoding: "utf8",
});
const ref = process.env.REMNIC_ANTI_SLOP_BASE_REF
  || (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "origin/main");
let base = git("merge-base", "HEAD", ref).trim();
if (base === git("rev-parse", "HEAD").trim()) base = git("rev-parse", "HEAD~1").trim();
const added = parseAddedLines(git("diff", "--no-color", "--unified=0", "--diff-filter=ACMR", base, "--"));
for (const file of git("ls-files", "--others", "--exclude-standard", "-z").split("\0")) {
  if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
  readFileSync(path.join(root, file), "utf8").split("\n").forEach((text, index) => {
    added.push({ file, line: index + 1, text });
  });
}
const changed = new Map();
for (const { file, line } of added) {
  if (!/\.[cm]?[jt]sx?$/.test(file) || file.startsWith("tools/oxlint/anti-slop/")) continue;
  if (!changed.has(file)) changed.set(file, new Set());
  changed.get(file).add(line);
}
if (changed.size === 0) {
  console.log("Anti-slop: no changed JavaScript or TypeScript lines.");
} else {
  const bin = path.join(path.dirname(require.resolve("oxlint/package.json")), "bin", "oxlint");
  const result = spawnSync(process.execPath, [bin, "--threads=2", "--format=json", "--", ...changed.keys()], {
    cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.signal || (result.status !== 0 && result.status !== 1)) {
    throw new Error(`Oxlint failed: ${result.stderr || result.signal || result.status}`);
  }
  const report = JSON.parse(result.stdout);
  const findings = report.diagnostics.filter((diagnostic) =>
    diagnostic.severity === "error" && (
      !changed.has(diagnostic.filename)
      || diagnostic.labels.length === 0
      || diagnostic.labels.some(({ span }) => changed.get(diagnostic.filename).has(span.line))
    ),
  );
  for (const finding of findings) {
    console.error(`${finding.filename}:${finding.labels[0]?.span.line ?? 0}: ${finding.code}: ${finding.message}`);
  }
  console.log(`Anti-slop: ${findings.length} errors on changed lines across ${changed.size} files.`);
  process.exitCode = findings.length > 0 ? 1 : 0;
}
