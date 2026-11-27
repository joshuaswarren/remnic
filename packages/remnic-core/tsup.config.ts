import { defineConfig } from "tsup";
import { readdirSync, cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
  "src/maintenance/rebuild-memory-projection-runner.ts",
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
  dts: false,
  external: [
    "openclaw",
    "@node-rs/argon2",
    "@lancedb/lancedb",
    "meilisearch",
    "@orama/orama",
    "@orama/plugin-data-persistence",
  ],
  async onSuccess() {
    const src = join(__dirname, "src", "connectors", "codex");
    const dest = join(__dirname, "dist", "connectors", "codex");
    cpSync(src, dest, { recursive: true });
  },
});
