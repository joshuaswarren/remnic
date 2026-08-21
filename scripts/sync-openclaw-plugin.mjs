import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const source = path.resolve(
  repoRoot,
  "packages",
  "plugin-openclaw",
  "openclaw.plugin.json",
);
const target = path.resolve(repoRoot, "openclaw.plugin.json");

const raw = await readFile(source, "utf-8");
// Atomic write (rule 54): temp-then-rename so a concurrent reader never sees a
// truncated manifest during a parallel build.
const tmp = `${target}.tmp-${process.pid}`;
await writeFile(tmp, `${JSON.stringify(JSON.parse(raw), null, 2)}\n`);
await rename(tmp, target);
