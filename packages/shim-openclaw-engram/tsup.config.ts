import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/access-cli.ts"],
  format: ["esm"],
  target: "es2022",
  platform: "node",
  outDir: "dist",
  clean: true,
  dts: true,
  external: [
    "openclaw",
    "@remnic/core",
    "@remnic/core/access-cli",
    "@remnic/plugin-openclaw",
  ],
});
