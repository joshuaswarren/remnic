import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { lintOkfDir } from "./lint.js";
import { runOkfConformanceSweep } from "./sweep.js";
import {
  assertNotOkfReservedBasename,
  okfTypeForCategory,
  okfTypeForEntityKind,
  okfTypeForMemory,
} from "./type-mapping.js";
import { parseOkfConfig } from "./config.js";
import { stripOkfProfileFrontmatter, withOkfProfileFrontmatter } from "../storage/profile-header.js";

test("okfTypeForCategory maps known categories and falls back", () => {
  assert.equal(okfTypeForCategory("fact"), "Memory Fact");
  assert.equal(okfTypeForCategory("decision"), "Decision");
  assert.equal(okfTypeForCategory("unknown-future"), "Memory");
});

test("okfTypeForMemory prefers Artifact when artifactType is set", () => {
  assert.equal(okfTypeForMemory({ category: "fact" }), "Memory Fact");
  assert.equal(okfTypeForMemory({ category: "fact", artifactType: "image" }), "Artifact");
});

test("okfTypeForEntityKind maps kinds and defaults to Entity", () => {
  assert.equal(okfTypeForEntityKind("person"), "Person");
  assert.equal(okfTypeForEntityKind("PROJECT"), "Project");
  assert.equal(okfTypeForEntityKind(undefined), "Entity");
});

test("reserved basenames are rejected", () => {
  assert.throws(() => assertNotOkfReservedBasename("/mem/index.md"), /reserved basename/);
  assert.throws(() => assertNotOkfReservedBasename("/mem/log.md"), /reserved basename/);
  assert.doesNotThrow(() => assertNotOkfReservedBasename("/mem/facts/fact-1.md"));
});

test("type never overrides category — mapping is presentation only", () => {
  assert.equal(okfTypeForCategory("fact"), "Memory Fact");
  assert.notEqual(okfTypeForCategory("fact"), "fact");
});

test("parseOkfConfig treats false as a real disable", () => {
  assert.deepEqual(parseOkfConfig({ conformanceEnabled: false, sweepEnabled: "false" }), {
    conformanceEnabled: false,
    sweepEnabled: false,
  });
  assert.throws(() => parseOkfConfig("nope"), /okf must be an object/);
});

test("profile OKF frontmatter strips back to the original injection bytes", () => {
  const original = "# User\n\nPrefers short answers.\n";
  const stamped = withOkfProfileFrontmatter(original, "2026-08-18T00:00:00.000Z", true);
  assert.match(stamped, /^---\n/);
  assert.match(stamped, /type: Profile/);
  assert.equal(stripOkfProfileFrontmatter(stamped), original);
  assert.equal(withOkfProfileFrontmatter(original, "2026-08-18T00:00:00.000Z", false), original);
});

test("lintOkfDir reports missing type and skips encrypted files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-okf-lint-"));
  try {
    await mkdir(path.join(dir, "facts", "2026-08-18"), { recursive: true });
    await writeFile(
      path.join(dir, "facts", "2026-08-18", "fact-ok.md"),
      "---\nid: fact-ok\ncategory: fact\ntype: Memory Fact\n---\n\nhello\n",
    );
    await writeFile(
      path.join(dir, "facts", "2026-08-18", "fact-bare.md"),
      "---\nid: fact-bare\ncategory: fact\n---\n\nno type\n",
    );
    await writeFile(path.join(dir, "secret.md"), "-----BEGIN REMNIC-----\ncipher\n");
    const result = lintOkfDir(dir);
    assert.equal(result.scanned, 3);
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((f) => f.code === "missing_type"));
    assert.ok(result.findings.some((f) => f.code === "skipped_encrypted"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sweep adds type without rewriting files that already have it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-okf-sweep-"));
  try {
    const file = path.join(dir, "fact-bare.md");
    await writeFile(file, "---\nid: fact-bare\ncategory: fact\nupdated: 2026-01-01T00:00:00.000Z\n---\n\nno type\n");
    assert.equal(runOkfConformanceSweep(dir, { sweepEnabled: false, conformanceEnabled: true }).written, 0);
    const first = runOkfConformanceSweep(dir, { sweepEnabled: true, conformanceEnabled: true });
    assert.equal(first.written, 1);
    const raw = await readFile(file, "utf8");
    assert.match(raw, /type: Memory Fact/);
    assert.match(raw, /updated: 2026-01-01T00:00:00.000Z/);
    assert.equal(runOkfConformanceSweep(dir, { sweepEnabled: true, conformanceEnabled: true }).written, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
