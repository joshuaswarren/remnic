import { defineConfig } from "tsup";
import { readdirSync, cpSync } from "node:fs";
import { join } from "node:path";

// Build all .ts files in src/ as individual entry points.
// Internal packages import specific modules directly from dist/.
const srcFiles = readdirSync(join(__dirname, "src"))
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
  .map((f) => `src/${f}`);

const connectorEntryFiles = [
  "src/contradiction/index.ts",
  "src/connectors/index.ts",
  "src/connectors/codex-materialize.ts",
  "src/connectors/codex-materialize-runner.ts",
];

export default defineConfig({
  entry: [...srcFiles, ...connectorEntryFiles],
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
