import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, "..");
const source = path.resolve(pkgDir, "../plugin-openclaw/openclaw.plugin.json");
const target = path.resolve(pkgDir, "openclaw.plugin.json");
const packageJsonPath = path.resolve(pkgDir, "package.json");

// Copy the manifest from plugin-openclaw, then patch the id back to the legacy
// shim id. The shim package (@joshuaswarren/openclaw-engram) intentionally keeps
// id="openclaw-engram" so existing OpenClaw configs keyed on "openclaw-engram"
// continue to resolve to this backwards-compat package. See #403.
const raw = await readFile(source, "utf-8");
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf-8"));
const manifest = JSON.parse(raw);
manifest.id = "openclaw-engram";
manifest.version = packageJson.version;
manifest.contracts = {
  ...manifest.contracts,
  memoryCapabilities: [manifest.id],
  services: [manifest.id],
};
manifest.providerAuthChoices = [
  {
    provider: "openai",
    method: "api-key",
    choiceId: "remnic-openai-api-key",
    choiceLabel: "OpenAI API key for Remnic memory extraction",
    choiceHint:
      "Remnic sends memory extraction, consolidation, and embedding requests to OpenAI or the configured OpenAI-compatible endpoint unless you route those tasks through OpenClaw gateway/local LLM settings.",
    groupId: "remnic-memory",
    groupLabel: "Remnic memory",
    optionKey: "openaiApiKey",
    cliFlag: "--openai-api-key",
    cliOption: "--openai-api-key <key>",
    cliDescription:
      "OpenAI API key used by Remnic memory extraction, consolidation, and embedding flows.",
    onboardingScopes: ["text-inference"],
  },
];
if (manifest.configSchema?.properties?.modelSource) {
  manifest.configSchema.properties.modelSource.default = "plugin";
  manifest.configSchema.properties.modelSource.description =
    "LLM source: 'plugin' uses Engram's own openai/localLlm config; 'gateway' delegates to a gateway agent's model chain (agents.list[]).";
}
await writeFile(target, JSON.stringify(manifest, null, 2) + "\n");
