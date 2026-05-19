import { defineConfig } from "tsup";
import { readdirSync, cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Build all top-level .ts files in src/ as individual entry points.
// Internal packages import specific modules directly from dist/.
const srcFiles = readdirSync(join(__dirname, "src"))
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
  .map((f) => `src/${f}`);

type PackageExportTarget = { import?: string };

const packageJson = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")) as {
  exports?: Record<string, string | PackageExportTarget>;
};

const sourceEntryForDistImport = (importPath: string): string | null => {
  if (!importPath.startsWith("./dist/") || !importPath.endsWith(".js")) return null;
  const entry = importPath.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts");
  return existsSync(join(__dirname, entry)) ? entry : null;
};

const publicExportEntryFiles = Object.values(packageJson.exports ?? {}).flatMap((target) => {
  const importPath = typeof target === "string" ? target : target.import;
  if (!importPath) return [];
  const sourceEntry = sourceEntryForDistImport(importPath);
  return sourceEntry ? [sourceEntry] : [];
});

const packageOwnedNestedEntryFiles = [
  "src/connectors/index.ts",
  "src/connectors/codex-materialize.ts",
  "src/connectors/codex-materialize-runner.ts",
  "src/contradiction/index.ts",
];

export default defineConfig({
  entry: [
    ...new Set([
      ...srcFiles,
      ...publicExportEntryFiles,
      ...packageOwnedNestedEntryFiles,
    ]),
  ],
  format: ["esm"],
  target: "es2022",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: true,
  external: [
    "openclaw",
    "@node-rs/argon2",
    "@lancedb/lancedb",
    "meilisearch",
    "@orama/orama",
    "@orama/plugin-data-persistence",
  ],
  async onSuccess() {
    // Recursively copy the entire Codex extension payload into dist/ so it is
    // shipped with the @remnic/core npm package. locatePluginCodexExtensionSource()
    // looks for dist/connectors/codex/ at runtime.
    //
    // Using recursive: true ensures any future subdirectories or additional
    // asset files added under src/connectors/codex/ are automatically included
    // in the built artifact without requiring further changes here.
    const src = join(__dirname, "src", "connectors", "codex");
    const dest = join(__dirname, "dist", "connectors", "codex");
    cpSync(src, dest, { recursive: true });
  },
});
