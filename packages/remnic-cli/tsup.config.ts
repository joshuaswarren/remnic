import { defineConfig } from "tsup";

// Keep optional @remnic packages external so the CLI remains à la carte.
// Their source modules use computed imports for optional runtime loading.
// Adding these packages to noExternal would bundle them into every CLI install.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  platform: "node",
  outDir: "dist",
  clean: true,
  external: [
    "yaml",
    "@remnic/bench",
    "@remnic/plugin-openclaw",
    "@remnic/export-weclone",
    "@remnic/import-weclone",
    "@remnic/import-chatgpt",
    "@remnic/import-gemini",
    "@remnic/import-lossless-claw",
    "@remnic/import-mem0",
    "@remnic/import-claude",
  ],
});
