/**
 * Issue #3574 — the Memory Worth recall multiplier shipped default-on after
 * its precision bench (issue #560 PR 5). These tests pin the shipped default
 * so the flag cannot drift back into a benchmark-gated rollout:
 *
 *  - the resolved config default is on, and an operator can still opt out;
 *  - every published manifest advertises the default the code resolves,
 *    because the OpenClaw SDK materializes the schema default into
 *    `api.pluginConfig` before `parseConfig` runs;
 *  - the bench verdict still justifies that default;
 *  - no docblock states a default that differs from the resolved default.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseConfig } from "./config.js";
import { runMemoryWorthBench } from "./memory-worth-bench.js";

const REPO_ROOT = new URL("../../../", import.meta.url);
const MANIFESTS = [
  "openclaw.plugin.json",
  "packages/plugin-openclaw/openclaw.plugin.json",
  "packages/shim-openclaw-engram/openclaw.plugin.json",
];

function readRepoFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, REPO_ROOT), "utf8");
}

/** The default a docblock claims, or null when it claims none. */
function statedDefault(docblock: string): string | null {
  const match = docblock.match(/default\s+`?(true|false)/i);
  return match ? (match[1] ?? "").toLowerCase() : null;
}

test("the memory-worth recall filter is on by default and operators can still opt out", () => {
  assert.equal(parseConfig({}).recallMemoryWorthFilterEnabled, true);
  assert.equal(parseConfig({ recallMemoryWorthFilterEnabled: false }).recallMemoryWorthFilterEnabled, false);
});

test("every published manifest advertises the default the code resolves", () => {
  const resolved = parseConfig({}).recallMemoryWorthFilterEnabled;
  for (const manifest of MANIFESTS) {
    // SAFETY: repo-owned manifest fixture; a missing configSchema or flag
    // yields undefined, which fails the equality assert below rather than
    // passing silently.
    const schema = JSON.parse(readRepoFile(manifest)).configSchema as
      | { properties?: Record<string, { default?: unknown }> }
      | undefined;
    assert.equal(
      schema?.properties?.recallMemoryWorthFilterEnabled?.default,
      resolved,
      `${manifest} must advertise the default parseConfig resolves`
    );
  }
});

test("the precision bench still justifies the shipped default", () => {
  const bench = runMemoryWorthBench();
  assert.equal(bench.filterWinsOrTies, true, "bench must keep the filter winning");
  assert.ok(bench.delta > 0.5, `bench delta ${bench.delta} must keep justifying the default`);
});

test("no docblock states a default that differs from the resolved default", () => {
  const resolved = String(parseConfig({}).recallMemoryWorthFilterEnabled);

  // types.ts: the docblock directly above the field declaration.
  const typesSource = readRepoFile("packages/remnic-core/src/types.ts");
  const declaration = "recallMemoryWorthFilterEnabled: boolean;";
  const declarationIndex = typesSource.indexOf(declaration);
  assert.ok(declarationIndex > 0, "types.ts must still declare the flag");
  const head = typesSource.slice(0, declarationIndex);
  const close = head.lastIndexOf("*/");
  const open = close >= 0 ? head.lastIndexOf("/**", close) : -1;
  if (open >= 0 && head.slice(close + 2).trim() === "") {
    const stated = statedDefault(typesSource.slice(open, close + 2));
    if (stated !== null) {
      assert.equal(stated, resolved, "types.ts states a stale default for the flag");
    }
  }

  // memory-worth-filter.ts: every docblock that talks about the flag.
  const filterSource = readRepoFile("packages/remnic-core/src/memory-worth-filter.ts");
  for (const match of filterSource.matchAll(/\/\*\*([\s\S]{0,4096}?)\*\//g)) {
    const docblock = match[1] ?? "";
    if (!docblock.includes("recallMemoryWorthFilterEnabled")) continue;
    const stated = statedDefault(docblock);
    if (stated !== null) {
      assert.equal(stated, resolved, "memory-worth-filter.ts states a stale default");
    }
  }
});
