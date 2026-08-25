/**
 * Relocation contract for the memory tool executors (#2914 phase 3, #2801).
 *
 * `memory-promote.ts` and `memory-action-target.ts` are OpenClaw tool wiring:
 * they only translate tool parameters into @remnic/core operations. They now
 * live in packages/plugin-openclaw and are consumed by root `src/tools.ts`
 * through the plugin's public subpath exports, which is what keeps the root
 * entry point loadable while the wiring itself moves.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { executeMemoryPromote } from "@remnic/plugin-openclaw/plugin/memory-promote";
import {
  blocksSupportPassportMutation,
  deriveMemoryActionPolicyEligibility,
  readReferencedMemoryForPolicyEligibility,
} from "@remnic/plugin-openclaw/plugin/memory-action-target";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

test("memory tool executors resolve from the plugin subpath exports", () => {
  assert.equal(typeof executeMemoryPromote, "function");
  assert.equal(typeof blocksSupportPassportMutation, "function");
  assert.equal(typeof deriveMemoryActionPolicyEligibility, "function");
  assert.equal(typeof readReferencedMemoryForPolicyEligibility, "function");
});

test("relocated executors keep their tool contracts", async () => {
  assert.equal(
    await executeMemoryPromote({} as never, { memoryId: "" }),
    'Invalid memoryId: "" — expected a non-empty memory ID.',
  );
  assert.equal(
    blocksSupportPassportMutation("discard", {
      frontmatter: { id: "m1", tags: ["support-passport-card"] },
    } as never),
    true,
  );
  assert.equal(
    blocksSupportPassportMutation("discard", { frontmatter: { id: "m2" } } as never),
    false,
  );
  assert.equal(
    blocksSupportPassportMutation("link_graph", null),
    false,
  );

  const eligibility = deriveMemoryActionPolicyEligibility({
    frontmatter: { id: "m3", confidence: 7, importance: { score: 2, level: "important", reasons: ["test"], keywords: ["k"] } },
  });
  assert.equal(eligibility?.confidence, 1);
  assert.equal(eligibility?.importance, 1);
  assert.equal(eligibility?.lifecycleState, "candidate");
  assert.equal(eligibility?.source, "unknown");

  assert.equal(await readReferencedMemoryForPolicyEligibility({}, undefined), undefined);
});

test("plugin package declares the relocated modules as public subpaths", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, "packages", "plugin-openclaw", "package.json"), "utf-8"),
  ) as { exports?: Record<string, Record<string, string>> };

  for (const subpath of ["./plugin/memory-promote", "./plugin/memory-action-target"]) {
    const entry = manifest.exports?.[subpath];
    assert.ok(entry, `${subpath} must be exported`);
    assert.equal(entry["remnic-source"], `./src${subpath.slice(1)}.ts`);
    assert.equal(entry.import, `./dist${subpath.slice(1)}.js`);
    assert.ok(entry.types?.endsWith(".d.ts"), `${subpath} must declare types`);
  }
});

test("root wiring consumes the plugin subpaths and keeps no stale copies", () => {
  assert.equal(
    fs.existsSync(path.join(ROOT, "src", "memory-promote.ts")),
    false,
    "src/memory-promote.ts must stay relocated",
  );
  assert.equal(
    fs.existsSync(path.join(ROOT, "src", "memory-action-target.ts")),
    false,
    "src/memory-action-target.ts must stay relocated",
  );

  const toolsSource = fs.readFileSync(path.join(ROOT, "src", "tools.ts"), "utf-8");
  assert.match(toolsSource, /from "@remnic\/plugin-openclaw\/plugin\/memory-promote"/);
  assert.match(toolsSource, /from "@remnic\/plugin-openclaw\/plugin\/memory-action-target"/);
});
