import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DEFAULT_MEETINGS_CONFIG } from "../packages/remnic-core/src/meetings/config.ts";
import { findFirstDuplicateJsonMember, runContractCheck } from "../scripts/config-contract/contract-check.ts";
import { extractRealConfigKeys } from "../scripts/config-contract/extract-parsed-keys.ts";

/**
 * meetings.* config-contract focus (issue #2936).
 *
 * The runtime meetings surface is parsed by exactly one construction site
 * (`parseMeetingsConfig` in packages/remnic-core/src/meetings/config.ts,
 * reached only through `parseCaptureCompanionConfigs(cfg)`), and every
 * runtime key must map to exactly one canonical schema path — `meetings.<k>`
 * — in every manifest. These tests lock that invariant so the drift class
 * the issue names (a doubled parsed key, a second meetings schema path, or
 * an alias block feeding the same runtime keys) fails loudly instead of
 * landing silently behind a grandfather entry.
 *
 * The expected key set is derived from `DEFAULT_MEETINGS_CONFIG` — the same
 * object the parser initializes every field from — so adding a runtime knob
 * without its schema/doc counterpart fails here, not in production.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

const MANIFEST_PATHS = [
  "openclaw.plugin.json",
  "packages/plugin-openclaw/openclaw.plugin.json",
  "packages/shim-openclaw-engram/openclaw.plugin.json",
] as const;

/** `meetings` + `meetings.<runtimeKey>` for every key of the runtime config. */
const CANONICAL_MEETINGS_KEYS: string[] = [
  "meetings",
  ...Object.keys(DEFAULT_MEETINGS_CONFIG).map((key) => `meetings.${key}`),
].sort();

interface JsonSchemaNode {
  properties?: Record<string, JsonSchemaNode>;
  [key: string]: unknown;
}

/** Flattened dotted property paths of a configSchema (JSON.parse semantics). */
function schemaPaths(schema: JsonSchemaNode): string[] {
  const out: string[] = [];
  const walk = (node: JsonSchemaNode, prefix: string): void => {
    if (!node.properties || typeof node.properties !== "object") return;
    for (const [name, child] of Object.entries(node.properties)) {
      const keyPath = prefix ? `${prefix}.${name}` : name;
      out.push(keyPath);
      walk(child, keyPath);
    }
  };
  walk(schema, "");
  return out;
}

/** Observe raw duplicate members, then walk the post-parse schema (#2949). */
function meetingsSchemaObservation(raw: string): {
  paths: string[];
  meetingsPaths: string[];
  rawDuplicate: { key: string; path: string } | null;
} {
  const parsed = JSON.parse(raw) as { configSchema?: JsonSchemaNode };
  const paths = schemaPaths(parsed.configSchema ?? {});
  return {
    paths,
    meetingsPaths: paths.filter((keyPath) => keyPath === "meetings" || keyPath.startsWith("meetings.")),
    rawDuplicate: findFirstDuplicateJsonMember(raw),
  };
}

const RAW_DUPLICATE_MEETINGS_MANIFEST = `{
  "configSchema": {
    "properties": {
      "meetings": {
        "type": "object",
        "properties": { "enabled": { "type": "boolean" } }
      },
      "meetings": {
        "type": "object",
        "properties": {
          "enabled": { "type": "boolean" },
          "mergeGapMinutes": { "type": "number" }
        }
      }
    }
  }
}
`;

test("parsed-keys snapshot carries each meetings runtime key exactly once (#2936)", () => {
  const snapshot = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "scripts", "config-contract", "parsed-keys.snapshot.json"), "utf8"),
  ) as { keys: string[] };
  const meetingsKeys = snapshot.keys.filter((key: string) => key.startsWith("meetings."));
  const duplicates = meetingsKeys.filter((key: string, index: number) => meetingsKeys.indexOf(key) !== index);
  assert.deepEqual(duplicates, [], "doubled parsed meetings keys — one construction site must produce one key");
  assert.deepEqual(
    [...meetingsKeys].sort(),
    CANONICAL_MEETINGS_KEYS.filter((key) => key !== "meetings"),
    "parsed meetings keys must be exactly the runtime MeetingsConfig surface",
  );
  const doubledSites = Object.entries(extractRealConfigKeys(REPO_ROOT).keyMultiplicity).filter(
    ([key, count]) => key.startsWith("meetings.") && count > 1,
  );
  assert.deepEqual(doubledSites, [], "parser multiplicity must stay 1 for every meetings.* key");
});

test("every manifest maps each meetings runtime key to exactly one canonical schema path (#2936)", () => {
  for (const manifestRel of MANIFEST_PATHS) {
    const observed = meetingsSchemaObservation(fs.readFileSync(path.join(REPO_ROOT, manifestRel), "utf8"));
    assert.equal(observed.rawDuplicate, null, `${manifestRel}: duplicate JSON member before parse`);
    const duplicates = observed.meetingsPaths.filter(
      (keyPath, index) => observed.meetingsPaths.indexOf(keyPath) !== index,
    );
    assert.deepEqual(duplicates, [], `${manifestRel}: doubled meetings schema keys`);
    assert.deepEqual(
      [...observed.meetingsPaths].sort(),
      CANONICAL_MEETINGS_KEYS,
      `${manifestRel}: meetings schema paths must be exactly the canonical runtime set`,
    );

    const outsideCanonical = observed.paths.filter(
      (keyPath) => /meeting/i.test(keyPath) && !observed.meetingsPaths.includes(keyPath),
    );
    assert.deepEqual(
      outsideCanonical,
      [],
      `${manifestRel}: meeting-shaped config paths outside the canonical meetings block`,
    );
  }
});

test("contract check reports zero meetings violations and zero meetings grandfather entries (#2936)", () => {
  const result = runContractCheck({ repoRoot: REPO_ROOT, checkGrandfatherBaseline: false });
  const violating = result.violations
    .map((violation) => `${violation.kind}:${violation.key}`)
    .filter((key) => /meeting/i.test(key));
  assert.deepEqual(violating, [], "active meetings contract violations — fix, do not grandfather");

  const grandfathered = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "scripts", "config-contract", "grandfathered.json"), "utf8"),
  ) as Array<{ kind: string; key: string; issue: string }>;
  const meetingsGrandfathered = grandfathered
    .map((entry) => `${entry.kind}:${entry.key}`)
    .filter((key) => /meeting/i.test(key));
  assert.deepEqual(
    meetingsGrandfathered,
    [],
    "meetings keys grandfathered in scripts/config-contract/grandfathered.json — the contract may not carry meetings exceptions",
  );
});

test("duplicate-schema observation sees raw doubled meetings members (#2949)", () => {
  const postParse = JSON.parse(RAW_DUPLICATE_MEETINGS_MANIFEST) as { configSchema?: JsonSchemaNode };
  const postParsePaths = schemaPaths(postParse.configSchema ?? {}).filter(
    (keyPath) => keyPath === "meetings" || keyPath.startsWith("meetings."),
  );
  const postParseDuplicates = postParsePaths.filter((keyPath, index) => postParsePaths.indexOf(keyPath) !== index);
  assert.deepEqual(postParseDuplicates, [], "JSON.parse collapses duplicate members — this is the mask");
  const observed = meetingsSchemaObservation(RAW_DUPLICATE_MEETINGS_MANIFEST);
  assert.equal(observed.rawDuplicate?.key, "meetings");
  assert.equal(observed.rawDuplicate?.path, "configSchema.properties.meetings");
});

test("raw duplicate meetings members fail closed before JSON.parse collapses them (#2940)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "config-contract-dup-"));
  try {
    fs.writeFileSync(
      path.join(root, "parser.ts"),
      `
type Rec = Record<string, unknown>;
export function parseRootConfig(raw: unknown): Rec {
  const cfg = raw && typeof raw === "object" ? (raw as Rec) : {};
  const meetings = cfg.meetings && typeof cfg.meetings === "object" ? (cfg.meetings as Rec) : {};
  return { meetings: { enabled: meetings.enabled === true } };
}
`,
    );
    // Raw text — JSON.stringify cannot emit the duplicate members this guards.
    fs.writeFileSync(
      path.join(root, "manifest.json"),
      `{
  "configSchema": {
    "properties": {
      "meetings": {
        "type": "object",
        "properties": { "enabled": { "type": "boolean" } }
      },
      "meetings": {
        "type": "object",
        "properties": {
          "enabled": { "type": "boolean" },
          "mergeGapMinutes": { "type": "number" }
        }
      }
    }
  }
}
`,
    );
    fs.writeFileSync(path.join(root, "docs.md"), "Config keys: `meetings.enabled`.\n");
    assert.throws(
      () =>
        runContractCheck({
          repoRoot: root,
          entryFile: path.join(root, "parser.ts"),
          entryFunction: "parseRootConfig",
          includeFiles: [],
          manifestPaths: [path.join(root, "manifest.json")],
          docsPath: path.join(root, "docs.md"),
          grandfatherPath: path.join(root, "grandfathered.json"),
          checkGrandfatherBaseline: false,
        }),
      /duplicate JSON member "meetings"/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
