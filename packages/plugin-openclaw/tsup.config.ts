import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/managed-upgrade.ts"],
  dts: { entry: ["src/managed-upgrade.ts"] },
  format: ["esm"],
  target: "es2022",
  platform: "node",
  outDir: "dist",
  clean: true,
  external: [
    "openclaw",
    "openai",
    "@remnic/core",
    "@node-rs/argon2",
    "@lancedb/lancedb",
    "meilisearch",
    "@orama/orama",
    "@orama/plugin-data-persistence",
    "better-sqlite3",
  ],
});
