import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// After #2483 the hook contract lives in remnic-hook-core.cjs.
// Source-grep tests that still only read the thin wrappers fail in CI
// (2511 root shard). This check fails if those tests omit the core file.

export const HOOK_CORE_REL = path.join(
  "packages",
  "plugin-codex",
  "hooks",
  "bin",
  "remnic-hook-core.cjs",
);

export const HOOK_CONTRACT_TESTS = [
  path.join("tests", "codex-materialize-consolidation-wiring.test.ts"),
  path.join("tests", "integration", "plugin-structure.test.ts"),
];

export function findHookGrepTargetMisses(root) {
  const corePath = path.join(root, HOOK_CORE_REL);
  if (!existsSync(corePath)) return [];
  const misses = [];
  for (const rel of HOOK_CONTRACT_TESTS) {
    const filePath = path.join(root, rel);
    if (!existsSync(filePath)) {
      misses.push(`${rel} (missing)`);
      continue;
    }
    const src = readFileSync(filePath, "utf8");
    if (!/(?:readFile(?:Sync)?|join)\([\s\S]{0,200}remnic-hook-core\.cjs/.test(src)) {
      misses.push(rel);
    }
  }
  return misses;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const misses = findHookGrepTargetMisses(root);
  if (misses.length > 0) {
    console.error(
      [
        "Hook contract tests must mention remnic-hook-core.cjs after the shared runner extract (#2483/#2511):",
        ...misses.map((item) => `  - ${item}`),
      ].join("\n"),
    );
    process.exit(1);
  }
}
