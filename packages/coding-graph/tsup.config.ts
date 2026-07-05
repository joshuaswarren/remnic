import { defineConfig } from "tsup";

// @remnic/coding-graph is an optional à-la-carte companion of @remnic/core
// (CLAUDE.md rule 57 / AGENTS.md rule 44). It MUST stay external here so
// the bundler does not statically link the optional package into the core
// build. Core consumes this package via a computed-specifier dynamic import
// (see packages/remnic-core/src/coding/optional-coding-graph.ts).
//
// The store modules (graph-schema, graph-store) and the Cypher layer
// (cypher/query-parser) emit their own bundles so the subpath exports
// `./graph-schema`, `./graph-store`, and `./cypher` resolve to standalone
// files; better-sqlite3 is marked external because it is a native binding
// and must never be bundled (rule 23/38 — the shared opener lives in
// @remnic/core/runtime/better-sqlite).
export default defineConfig({
  entry: [
    "src/index.ts",
    "src/graph-schema.ts",
    "src/graph-store.ts",
    "src/cypher/query-parser.ts",
  ],
  format: ["esm"],
  target: "es2022",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: true,
  external: ["@remnic/core", "better-sqlite3"],
});
