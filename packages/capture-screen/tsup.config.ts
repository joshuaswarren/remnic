import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli-bin.ts"],
  format: ["esm"],
  target: "es2022",
  platform: "node",
  outDir: "dist",
  clean: true,
  removeNodeProtocol: false,
  dts: true,
  noExternal: ["@remnic/core/activity/digest"],
});
