import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runOkfCliCommand } from "./cli.js";
import { lintOkfDir } from "./lint.js";
import { runOkfConformanceSweep } from "./sweep.js";
import {
  assertNotOkfReservedBasename,
  okfTypeForCategory,
  okfTypeForEntityKind,
  okfTypeForMemory,
} from "./type-mapping.js";
import { parseEntityFile, serializeEntityFile } from "../storage.js";
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

test("lintOkfDir reports missing type and skips only real encrypted envelopes", async () => {
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
    // Binary secure-store envelope: starts with the REMNIC-ENC magic header.
    await writeFile(path.join(dir, "secret.md"), "REMNIC-ENC\x00\x01cipher-bytes");
    // Plaintext that merely mentions an encryption marker is NOT skipped.
    await writeFile(
      path.join(dir, "mentions-enc.md"),
      "---\nid: mentions-enc\ncategory: fact\n---\n\ndiscusses enc:v1 in prose\n",
    );
    const result = lintOkfDir(dir);
    assert.equal(result.scanned, 4);
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((f) => f.code === "missing_type"));
    const encrypted = result.findings.filter((f) => f.code === "skipped_encrypted");
    assert.equal(encrypted.length, 1);
    assert.equal(encrypted[0]!.file, "secret.md");
    assert.ok(result.findings.some((f) => f.file === "mentions-enc.md" && f.code === "missing_type"));
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

test("sweep replaces an empty type in place and stays idempotent", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-okf-sweep-empty-"));
  try {
    const file = path.join(dir, "fact-empty.md");
    await writeFile(file, "---\nid: fact-empty\ncategory: decision\ntype:\nupdated: 2026-01-01T00:00:00.000Z\n---\n\nempty type\n");
    assert.equal(runOkfConformanceSweep(dir, { sweepEnabled: true, conformanceEnabled: true }).written, 1);
    const raw = await readFile(file, "utf8");
    const typeLines = raw.split("\n").filter((line) => line.startsWith("type:"));
    assert.equal(typeLines.length, 1, "no duplicate type key after sweep");
    assert.equal(typeLines[0], "type: Decision");
    assert.match(raw, /updated: 2026-01-01T00:00:00.000Z/);
    assert.equal(runOkfConformanceSweep(dir, { sweepEnabled: true, conformanceEnabled: true }).written, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sweep handles CRLF frontmatter the same as LF", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-okf-sweep-crlf-"));
  try {
    const file = path.join(dir, "fact-crlf.md");
    await writeFile(
      file,
      "---\r\nid: fact-crlf\r\ncategory: fact\r\n---\r\n\r\ncrlf body\r\n",
    );
    assert.equal(runOkfConformanceSweep(dir, { sweepEnabled: true, conformanceEnabled: true }).written, 1);
    const raw = await readFile(file, "utf8");
    const typeLine = raw.split("\n").find((line) => line.startsWith("type:"));
    assert.equal(typeLine, "type: Memory Fact\r");
    assert.equal(runOkfConformanceSweep(dir, { sweepEnabled: true, conformanceEnabled: true }).written, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("profile OKF frontmatter strip tolerates CRLF-rewritten files", () => {
  // A CRLF-rewriting editor converts the whole stamped file, OKF block included.
  const crlfStamped =
    "---\r\ntype: Profile\r\ntitle: User Profile\r\ntimestamp: 2026-08-18T00:00:00.000Z\r\n---\r\n# User\r\n\r\nPrefers short answers.\r\n";
  assert.equal(stripOkfProfileFrontmatter(crlfStamped), "# User\r\n\r\nPrefers short answers.\r\n");
  // Hand-written CRLF frontmatter without the marker round-trips untouched.
  const handWritten = "---\r\ntitle: mine\r\n---\r\n\r\nbody\r\n";
  assert.equal(stripOkfProfileFrontmatter(handWritten), handWritten);
});

test("runOkfCliCommand handles help and rejects unexpected tokens", async () => {
  const chunks: string[] = [];
  const stdout = { write: (s: string) => void chunks.push(s) } as unknown as NodeJS.WritableStream;
  for (const argv of [["--help"], ["-h"], ["help"]]) {
    const stderr = { write: () => {} } as unknown as NodeJS.WritableStream;
    const code = await runOkfCliCommand(argv, { stdout, stderr }, {
      memoryDir: "/tmp",
      conformanceEnabled: true,
      sweepEnabled: false,
    });
    assert.equal(code, 0);
    assert.match(chunks.join(""), /usage: remnic okf/);
  }
  const errChunks: string[] = [];
  const stderr = { write: (s: string) => void errChunks.push(s) } as unknown as NodeJS.WritableStream;
  for (const token of ["--json=1", "--unknown", "stray"]) {
    errChunks.length = 0;
    const code = await runOkfCliCommand(["lint", token], { stdout, stderr }, {
      memoryDir: "/tmp",
      conformanceEnabled: true,
      sweepEnabled: false,
    });
    assert.equal(code, 1);
    assert.match(errChunks.join(""), new RegExp(`unexpected argument '${token}'`));
  }
});

test("serializeEntityFile okfType gate omits type when off, emits one when on", () => {
  const raw = [
    "---",
    "created: 2026-01-01T00:00:00.000Z",
    "updated: 2026-01-01T00:00:00.000Z",
    "type: Entity",
    "---",
    "",
    "# Jane",
    "",
    "**Type:** person",
    "**Updated:** 2026-01-01T00:00:00.000Z",
    "",
  ].join("\n");
  const entity = parseEntityFile(raw);
  const off = serializeEntityFile(entity, undefined, false);
  const on = serializeEntityFile(entity, undefined, true);
  // Gate off: no type metadata is emitted (matches the questions-path gate).
  assert.doesNotMatch(off, /^type:/m);
  // Gate on: exactly one type, recomputed from the entity kind.
  assert.equal(on.split("\n").filter((line) => line.startsWith("type:")).length, 1);
  assert.match(on, /^type: Person$/m);
});
