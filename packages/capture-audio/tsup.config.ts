import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli-bin.ts"],
  format: ["esm"],
  dts: true,
  removeNodeProtocol: false,
});
