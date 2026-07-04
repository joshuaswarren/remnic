import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/graph-schema.ts", "src/graph-store.ts"],
  format: ["esm"],
  target: "es2022",
  platform: "node",
  outDir: "dist",
  clean: true,
  dts: false,
  external: [/@remnic\/core/, "better-sqlite3"],
});
