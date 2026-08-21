import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/publisher.ts"],
  format: ["esm"],
  target: "es2022",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: true,
  bundle: true,
  external: ["@remnic/core", "@sinclair/typebox"],
});
