import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/access-cli.ts", "src/cli.ts"],
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
  banner: {
    js: "// openclaw-engram: Local-first memory plugin",
  },
});
