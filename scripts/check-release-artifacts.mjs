import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
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
  "dist/admin-console/public/relay/index.html",
  "dist/admin-console/public/relay/relay.css",
  "dist/admin-console/public/relay/relay-model.js",
  "dist/admin-console/public/relay/relay.js",
  "dist/admin-console/public/relay/replay.json",
  "dist/admin-console/public/what-helps-me/index.html",
  "dist/admin-console/public/what-helps-me/what-helps-me.css",
  "dist/admin-console/public/what-helps-me/model.js",
  "dist/admin-console/public/what-helps-me/app.js",
  "packages/remnic-core/dist/admin-console/public/what-helps-me/index.html",
  "packages/remnic-core/dist/admin-console/public/what-helps-me/what-helps-me.css",
  "packages/remnic-core/dist/admin-console/public/what-helps-me/model.js",
  "packages/remnic-core/dist/admin-console/public/what-helps-me/app.js",
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

const transferShims = (await readdir(path.join(repoRoot, "src", "transfer"), { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
  .map((entry) => entry.name.replace(/\.ts$/, ""))
  .sort();

for (const name of transferShims) {
  requiredFiles.push(`dist/transfer/${name}.js`);
}

await Promise.all(requiredFiles.map(assertFile));

await Promise.all(
  [
    "remnic-workspace/consolidation-operator",
    "remnic-workspace/consolidation-operator.js",
    "remnic-workspace/consolidation-undo",
    "remnic-workspace/consolidation-undo.js",
    "remnic-workspace/delinearize",
    "remnic-workspace/delinearize.js",
    "remnic-workspace/embedding-fallback",
    "remnic-workspace/embedding-fallback.js",
    "remnic-workspace/enrichment",
    "remnic-workspace/enrichment.js",
    "remnic-workspace/evals",
    "remnic-workspace/evals.js",
    "remnic-workspace/explicit-capture",
    "remnic-workspace/explicit-capture.js",
    "remnic-workspace/importance",
    "remnic-workspace/importance.js",
    "remnic-workspace/openai-chat-compat",
    "remnic-workspace/openai-chat-compat.js",
    "remnic-workspace/operator-toolkit",
    "remnic-workspace/operator-toolkit.js",
    "remnic-workspace/opik-exporter",
    "remnic-workspace/opik-exporter.js",
    "remnic-workspace/profiling",
    "remnic-workspace/profiling.js",
    "remnic-workspace/migrate/from-engram",
    "remnic-workspace/lcm",
    "remnic-workspace/lcm/engine",
    "remnic-workspace/qmd",
    "remnic-workspace/qmd.js",
    "remnic-workspace/qmd-recall-cache",
    "remnic-workspace/qmd-recall-cache.js",
    "remnic-workspace/relevance",
    "remnic-workspace/relevance.js",
    "remnic-workspace/rerank",
    "remnic-workspace/rerank.js",
    "remnic-workspace/retrieval",
    "remnic-workspace/retrieval.js",
    "remnic-workspace/retrieval-agents",
    "remnic-workspace/retrieval-agents.js",
    "remnic-workspace/resume-bundles",
    "remnic-workspace/resume-bundles.js",
    "remnic-workspace/sanitize",
    "remnic-workspace/sanitize.js",
    "remnic-workspace/schemas",
    "remnic-workspace/schemas.js",
    "remnic-workspace/sdk-compat",
    "remnic-workspace/sdk-compat.js",
    "remnic-workspace/signal",
    "remnic-workspace/signal.js",
    "remnic-workspace/source-attribution",
    "remnic-workspace/source-attribution.js",
    "remnic-workspace/summarizer",
    "remnic-workspace/summarizer.js",
    "remnic-workspace/summary-snapshot",
    "remnic-workspace/summary-snapshot.js",
    "remnic-workspace/threading",
    "remnic-workspace/threading.js",
    "remnic-workspace/tmt",
    "remnic-workspace/tmt.js",
    "remnic-workspace/topics",
    "remnic-workspace/topics.js",
    "remnic-workspace/transcript",
    "remnic-workspace/transcript.js",
    "remnic-workspace/trust-zones",
    "remnic-workspace/trust-zones.js",
    "remnic-workspace/types",
    "remnic-workspace/types.js",
    "remnic-workspace/transfer/export-md",
    "remnic-workspace/transfer/capsule-export",
    "remnic-workspace/transfer/import-json",
  ].map((specifier) =>
    import(specifier).catch((err) => {
      throw new Error(`root package subpath import failed for ${specifier}`, {
        cause: err,
      });
    })
  )
);

const [rootManifest, packageManifest] = await Promise.all([
  readFile(path.join(repoRoot, "openclaw.plugin.json"), "utf8"),
  readFile(path.join(repoRoot, "packages", "plugin-openclaw", "openclaw.plugin.json"), "utf8"),
]);

assert.equal(
  normalizeJson(rootManifest),
  normalizeJson(packageManifest),
  "root openclaw.plugin.json must stay synced with packages/plugin-openclaw/openclaw.plugin.json"
);
