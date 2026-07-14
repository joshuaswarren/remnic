import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/demo/mcp-memory-server.ts"],
  format: ["esm"],
  target: "es2022",
  platform: "node",
  outDir: "dist",
  clean: true,
  dts: true,
  external: ["@remnic/core", "@remnic/coding-graph"],
});
