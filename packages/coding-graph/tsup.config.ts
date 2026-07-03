import { defineConfig } from "tsup";

// @remnic/coding-graph is an optional à-la-carte companion of @remnic/core
// (CLAUDE.md rule 57 / AGENTS.md rule 44). It MUST stay external here so
// the bundler does not statically link the optional package into the core
// build. Core consumes this package via a computed-specifier dynamic import
// (see packages/remnic-core/src/coding/optional-coding-graph.ts).
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: true,
  external: ["@remnic/core"],
});
