import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootPackageJsonPath = path.join(repoRoot, "package.json");

async function assertFile(relativePath) {
  await access(path.join(repoRoot, relativePath));
}

function normalizeJson(raw) {
  return `${JSON.stringify(JSON.parse(raw), null, 2)}\n`;
}

const requiredFiles = [
  "dist/index.js",
  "dist/access-cli.js",
  "dist/cli.js",
  "dist/connectors/index.js",
  "dist/connectors/codex-materialize.js",
  "dist/connectors/codex-materialize-runner.js",
  "dist/migrate/from-engram.js",
  "dist/admin-console/public/index.html",
  "dist/admin-console/public/app.js",
];

const rootPackageJson = JSON.parse(await readFile(rootPackageJsonPath, "utf8"));
const exportedDistFiles = new Set();
for (const target of Object.values(rootPackageJson.exports ?? {})) {
  const importTarget =
    typeof target === "string"
      ? target
      : target && typeof target === "object" && typeof target.import === "string"
        ? target.import
        : null;
  if (!importTarget?.startsWith("./dist/") || importTarget.includes("*")) continue;
  exportedDistFiles.add(importTarget.slice(2));
}
requiredFiles.push(...[...exportedDistFiles].sort());

const transferShims = (
  await readdir(path.join(repoRoot, "src", "transfer"), { withFileTypes: true })
)
  .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
  .map((entry) => entry.name.replace(/\.ts$/, ""))
  .sort();

for (const name of transferShims) {
  requiredFiles.push(`dist/transfer/${name}.js`);
}

await Promise.all(requiredFiles.map(assertFile));

await Promise.all(
  [
    "remnic-workspace/migrate/from-engram",
    "remnic-workspace/lcm",
    "remnic-workspace/lcm/engine",
    "remnic-workspace/transfer/export-md",
    "remnic-workspace/transfer/capsule-export",
    "remnic-workspace/transfer/import-json",
  ].map((specifier) =>
    import(specifier).catch((err) => {
      throw new Error(`root package subpath import failed for ${specifier}`, {
        cause: err,
      });
    }),
  ),
);

const [rootManifest, packageManifest] = await Promise.all([
  readFile(path.join(repoRoot, "openclaw.plugin.json"), "utf8"),
  readFile(
    path.join(repoRoot, "packages", "plugin-openclaw", "openclaw.plugin.json"),
    "utf8",
  ),
]);

assert.equal(
  normalizeJson(rootManifest),
  normalizeJson(packageManifest),
  "root openclaw.plugin.json must stay synced with packages/plugin-openclaw/openclaw.plugin.json",
);
