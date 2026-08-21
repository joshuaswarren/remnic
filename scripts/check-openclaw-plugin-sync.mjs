import { readFile } from "node:fs/promises";
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

function normalizeManifest(raw) {
  return `${JSON.stringify(JSON.parse(raw), null, 2)}\n`;
}

const [sourceRaw, targetRaw] = await Promise.all([
  readFile(source, "utf-8"),
  readFile(target, "utf-8"),
]);

if (normalizeManifest(sourceRaw) !== normalizeManifest(targetRaw)) {
  console.error(
    [
      "openclaw.plugin.json is out of sync with packages/plugin-openclaw/openclaw.plugin.json.",
      "Run `npm run sync:openclaw-plugin` and commit the regenerated root manifest.",
    ].join("\n"),
  );
  process.exit(1);
}
