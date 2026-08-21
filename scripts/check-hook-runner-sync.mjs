import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Fail when a host package's copy of the shared hook runner (issue #2483)
// drifts from the canonical source. Mirrors check-openclaw-plugin-sync.mjs.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const source = path.resolve(repoRoot, "scripts", "hook-runner", "remnic-hook-core.cjs");
const targets = [
  path.resolve(repoRoot, "packages", "plugin-claude-code", "hooks", "bin", "remnic-hook-core.cjs"),
  path.resolve(repoRoot, "packages", "plugin-codex", "hooks", "bin", "remnic-hook-core.cjs"),
];

const canonical = await readFile(source, "utf8");
const drifted = [];
for (const target of targets) {
  let raw;
  try {
    raw = await readFile(target, "utf8");
  } catch {
    drifted.push(`${path.relative(repoRoot, target)} (missing)`);
    continue;
  }
  if (raw !== canonical) drifted.push(path.relative(repoRoot, target));
}

if (drifted.length > 0) {
  console.error(
    [
      `Shared hook runner out of sync: ${drifted.join(", ")}.`,
      "Edit scripts/hook-runner/remnic-hook-core.cjs (the canonical source), then run `npm run sync:hook-runner` and commit the regenerated copies.",
    ].join("\n"),
  );
  process.exit(1);
}
