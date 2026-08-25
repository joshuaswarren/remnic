import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/managed-upgrade.ts",
    "src/support-passport-model-route.ts",
    "src/plugin/memory-action-target.ts",
    "src/plugin/memory-promote.ts",
  ],
  dts: {
    entry: [
      "src/managed-upgrade.ts",
      "src/support-passport-model-route.ts",
      "src/plugin/memory-action-target.ts",
      "src/plugin/memory-promote.ts",
    ],
    compilerOptions: {
      customConditions: ["remnic-source"],
    },
  },
  format: ["esm"],
  target: "es2022",
  platform: "node",
  outDir: "dist",
  clean: true,
  external: [
    "openclaw",
    "openai",
    "@remnic/core",
    "@remnic/plugin-openclaw/plugin/memory-action-target",
    "@remnic/plugin-openclaw/plugin/memory-promote",
    "@remnic/plugin-openclaw/support-passport-model-route",
    "@remnic/server",
    "@node-rs/argon2",
    "@lancedb/lancedb",
    "meilisearch",
    "@orama/orama",
    "@orama/plugin-data-persistence",
    "better-sqlite3",
  ],
});
