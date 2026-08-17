import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Sync the canonical shared hook runner (issue #2483) into every host package
// that ships it. Mirrors sync-openclaw-plugin.mjs: one canonical source,
// generated package copies, CI drift check (check-hook-runner-sync.mjs).
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const source = path.resolve(repoRoot, "scripts", "hook-runner", "remnic-hook-core.cjs");
const targets = [
  path.resolve(repoRoot, "packages", "plugin-claude-code", "hooks", "bin", "remnic-hook-core.cjs"),
  path.resolve(repoRoot, "packages", "plugin-codex", "hooks", "bin", "remnic-hook-core.cjs"),
];

const body = await readFile(source, "utf8");
for (const target of targets) {
  await mkdir(path.dirname(target), { recursive: true });
  // Atomic write (rule 54): temp-then-rename so a concurrent reader never
  // sees a truncated runner during a parallel build.
  const tmp = `${target}.tmp-${process.pid}`;
  await writeFile(tmp, body);
  await rename(tmp, target);
  console.log(`synced ${path.relative(repoRoot, target)}`);
}
