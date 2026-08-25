import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/explicit-capture.ts",
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
    "@remnic/plugin-openclaw/plugin/memory-action-target",
    "@remnic/plugin-openclaw/plugin/memory-promote",
    "@remnic/plugin-openclaw/support-passport-model-route",
    "@remnic/server",
    "@node-rs/argon2",
    "@lancedb/lancedb",
    "meilisearch",
    "@orama/orama",
    "@orama/plugin-data-persistence",
  ],
  banner: {
    js: "// openclaw-engram: Local-first memory plugin",
  },
});
