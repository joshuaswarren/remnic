import { writeFileAtomically } from "@remnic/core/maintenance/atomic-file";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInjectionSuiteCorpusManifest } from "../../../src/security/injection-suite/corpus.js";
import { H5_DECISION_RULE_BYTES } from "../../../src/security/injection-suite/decision-rule.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const ARMS = {
  schemaVersion: 1,
  arms: {
    none: { memoryInjectionDefenseMode: "off" },
    fencing: { memoryInjectionDefenseMode: "fencing" },
    quarantine: { memoryInjectionDefenseMode: "quarantine" },
    both: { memoryInjectionDefenseMode: "layered" },
    "structured-boundary": {
      memoryInjectionDefenseMode: "off",
      implementation: "structured-prompt-local",
    },
    "spotlighting-marking": {
      memoryInjectionDefenseMode: "off",
      implementation: "marking-only-inspired",
    },
    "source-authenticated-fencing": { memoryInjectionDefenseMode: "fencing" },
    "control-data-isolation": {
      memoryInjectionDefenseMode: "off",
      implementation: "deny-all-control-flow-approximation",
    },
    "layered-fence-quarantine": { memoryInjectionDefenseMode: "layered" },
  },
  untrustedOrigins: [
    "user",
    "tool_output",
    "connector:*",
    "import:*",
    "unknown",
  ],
};

const SCENARIO_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "H5 frozen scenario manifest",
  type: "object",
  required: [
    "schemaVersion",
    "suiteVersion",
    "stage",
    "seed",
    "scenarios",
    "manifestSha256",
  ],
  properties: {
    schemaVersion: { const: 1 },
    suiteVersion: { type: "string" },
    stage: {
      enum: [
        "base",
        "adaptive-r1",
        "adaptive-r2",
        "adaptive-r3",
        "benign",
        "benign-use",
      ],
    },
    seed: { type: "integer" },
    scenarios: { type: "array", minItems: 40 },
    manifestSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
  },
  additionalProperties: true,
};

const EPISODE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "H5 episode row",
  type: "object",
  required: [
    "rowKey",
    "identity",
    "attackSucceeded",
    "canaryEmitted",
    "quarantined",
    "fenced",
  ],
  properties: {
    rowKey: { type: "string", pattern: "^h5-row-v2-[0-9a-f]{64}$" },
    identity: { type: "object" },
    attackSucceeded: { type: "boolean" },
    canaryEmitted: { type: "boolean" },
    quarantined: { type: "boolean" },
    fenced: { type: "boolean" },
    evidence: { type: "object" },
  },
  additionalProperties: false,
};

async function writeJson(relative: string, value: unknown): Promise<void> {
  const target = path.join(ROOT, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFileAtomically(target, `${JSON.stringify(value, null, 2)}\n`);
}

await Promise.all([
  writeJson(
    "base/manifest.json",
    buildInjectionSuiteCorpusManifest("base", 100, 71),
  ),
  writeJson(
    "benign-twins/manifest.json",
    buildInjectionSuiteCorpusManifest("benign", 10, 71),
  ),
  writeJson(
    "benign-use/manifest.json",
    buildInjectionSuiteCorpusManifest("benign-use", 10, 71),
  ),
  writeJson(
    "adaptive-r1/manifest.json",
    buildInjectionSuiteCorpusManifest("adaptive-r1", 100, 71),
  ),
  writeJson(
    "adaptive-r2/manifest.json",
    buildInjectionSuiteCorpusManifest("adaptive-r2", 100, 71),
  ),
  writeJson(
    "adaptive-r3/manifest.json",
    buildInjectionSuiteCorpusManifest("adaptive-r3", 100, 71),
  ),
  writeJson("arms/arms.json", ARMS),
  writeJson("schema/scenario-manifest.schema.json", SCENARIO_SCHEMA),
  writeJson("schema/episode.schema.json", EPISODE_SCHEMA),
  writeFileAtomically(
    path.join(ROOT, "decision-rule.json"),
    H5_DECISION_RULE_BYTES,
  ),
]);
