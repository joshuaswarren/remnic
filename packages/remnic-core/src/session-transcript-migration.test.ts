import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { sessionStoragePaths } from "./session-identity.js";
import { migrateSessionTranscripts, planSessionTranscriptMigration } from "./session-transcript-migration.js";

async function makeMemoryDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "remnic-sess-mig-"));
}

function entryLine(sessionKey: string, turnId: string, role: "user" | "assistant"): string {
  return JSON.stringify({
    sessionKey,
    turnId,
    role,
    content: `content-${turnId}`,
    timestamp: `2026-06-29T10:0${turnId}:00.000Z`,
  });
}

async function seedMixedOtherDefault(memoryDir: string, fileName: string, lines: string[]): Promise<string> {
  const dir = path.join(memoryDir, "transcripts", "other", "default");
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  await writeFile(filePath, `${lines.join("\n")}\n`, "utf-8");
  return filePath;
}

test("dry-run reports expected splits for mixed other/default file and changes nothing", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    const fileName = "2026-06-29.jsonl";
    const lines = [
      entryLine("pi-geek:abc123", "1", "user"),
      entryLine("pi-friend:def456", "2", "user"),
      entryLine("pi-geek:abc123", "3", "assistant"),
    ];
    const sourcePath = await seedMixedOtherDefault(memoryDir, fileName, lines);

    const plan = await planSessionTranscriptMigration({ memoryDir });
    assert.equal(plan.dryRun, true);
    assert.equal(plan.files.length, 1);
    assert.equal(plan.distinctSessions, 2);
    assert.equal(plan.movedEntries, 3);

    const groupKeys = plan.files[0].groups.map((g) => g.sessionKey).sort();
    assert.deepEqual(groupKeys, ["pi-friend:def456", "pi-geek:abc123"]);

    // Nothing moved.
    const before = await readFile(sourcePath, "utf-8");
    assert.equal(before.split("\n").filter(Boolean).length, 3);
    const sessionDir = path.join(memoryDir, "transcripts", "session");
    await assert.rejects(() => readdir(sessionDir));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("apply is lossless: every entry lands in its session dir, source is emptied", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    const fileName = "2026-06-29.jsonl";
    const lines = [
      entryLine("pi-geek:abc123", "1", "user"),
      entryLine("pi-friend:def456", "2", "user"),
      entryLine("pi-geek:abc123", "3", "assistant"),
    ];
    await seedMixedOtherDefault(memoryDir, fileName, lines);

    const result = await migrateSessionTranscripts({ memoryDir, apply: true });
    assert.equal(result.applied, true);
    assert.equal(result.errors.length, 0);

    const geekDir = sessionStoragePaths("pi-geek:abc123").dir;
    const friendDir = sessionStoragePaths("pi-friend:def456").dir;

    const geekContent = await readFile(path.join(memoryDir, "transcripts", geekDir, fileName), "utf-8");
    const friendContent = await readFile(path.join(memoryDir, "transcripts", friendDir, fileName), "utf-8");

    const geekLines = geekContent.split("\n").filter(Boolean);
    const friendLines = friendContent.split("\n").filter(Boolean);
    assert.equal(geekLines.length, 2);
    assert.equal(friendLines.length, 1);

    // Ordering preserved within a session (turn 1 before turn 3).
    assert.ok(geekLines[0].includes('"turnId":"1"'));
    assert.ok(geekLines[1].includes('"turnId":"3"'));

    // Source other/default file removed (no entries retained).
    await assert.rejects(() => readFile(path.join(memoryDir, "transcripts", "other", "default", fileName), "utf-8"));

    // No entries lost: 3 in, 3 out.
    assert.equal(geekLines.length + friendLines.length, 3);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("apply is idempotent: a second run finds nothing to migrate and does not duplicate", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    const fileName = "2026-06-29.jsonl";
    const lines = [entryLine("pi-geek:abc123", "1", "user"), entryLine("pi-geek:abc123", "2", "assistant")];
    await seedMixedOtherDefault(memoryDir, fileName, lines);

    const first = await migrateSessionTranscripts({ memoryDir, apply: true });
    assert.equal(first.errors.length, 0);

    const second = await migrateSessionTranscripts({ memoryDir, apply: true });
    assert.equal(second.errors.length, 0);
    assert.equal(second.plan.files.length, 0);
    assert.equal(second.plan.movedEntries, 0);

    const geekDir = sessionStoragePaths("pi-geek:abc123").dir;
    const geekContent = await readFile(path.join(memoryDir, "transcripts", geekDir, fileName), "utf-8");
    // Still exactly 2 lines — no duplication.
    assert.equal(geekContent.split("\n").filter(Boolean).length, 2);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("unparseable and legacy-homed lines are retained in the source file", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    const fileName = "2026-06-29.jsonl";
    // One arbitrary key (movable), one malformed line (retained).
    const lines = [entryLine("pi-geek:abc123", "1", "user"), "{not valid json"];
    await seedMixedOtherDefault(memoryDir, fileName, lines);

    const result = await migrateSessionTranscripts({ memoryDir, apply: true });
    assert.equal(result.errors.length, 0);

    // Source retains the malformed line (not deleted).
    const sourceContent = await readFile(path.join(memoryDir, "transcripts", "other", "default", fileName), "utf-8");
    assert.ok(sourceContent.includes("{not valid json"));

    // The movable entry landed in its session dir.
    const geekDir = sessionStoragePaths("pi-geek:abc123").dir;
    const geekContent = await readFile(path.join(memoryDir, "transcripts", geekDir, fileName), "utf-8");
    assert.equal(geekContent.split("\n").filter(Boolean).length, 1);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

async function seedLegacyParserDir(
  memoryDir: string,
  channelType: string,
  channelId: string,
  fileName: string,
  lines: string[]
): Promise<string> {
  const dir = path.join(memoryDir, "transcripts", channelType, channelId);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  await writeFile(filePath, `${lines.join("\n")}\n`, "utf-8");
  return filePath;
}

test("migration scan picks up pre-existing foo:bar:baz data under old baz/default", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    const fileName = "2026-06-29.jsonl";
    // OLD build stored foo:bar:baz under baz/default (parts.length >= 3 parser).
    const sourcePath = await seedLegacyParserDir(memoryDir, "baz", "default", fileName, [
      entryLine("foo:bar:baz", "1", "user"),
      entryLine("foo:bar:baz", "2", "assistant"),
    ]);

    const plan = await planSessionTranscriptMigration({ memoryDir });
    assert.equal(plan.files.length, 1, "baz/default must be a migration candidate");
    assert.equal(plan.distinctSessions, 1);
    assert.equal(plan.movedEntries, 2);

    const result = await migrateSessionTranscripts({ memoryDir, apply: true });
    assert.equal(result.errors.length, 0);

    const destDir = sessionStoragePaths("foo:bar:baz").dir;
    const destContent = await readFile(path.join(memoryDir, "transcripts", destDir, fileName), "utf-8");
    assert.equal(destContent.split("\n").filter(Boolean).length, 2);

    // Source emptied/removed.
    await assert.rejects(() => readFile(sourcePath, "utf-8"));

    // Idempotent: a second run finds nothing.
    const second = await migrateSessionTranscripts({ memoryDir, apply: true });
    assert.equal(second.plan.files.length, 0);
    assert.equal(second.plan.movedEntries, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("migration leaves legitimate legacy agent:<id>:main data in place (dest === source)", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    const fileName = "2026-06-29.jsonl";
    // agent:generalist:main legitimately lives in main/default and must NOT move.
    await seedLegacyParserDir(memoryDir, "main", "default", fileName, [
      entryLine("agent:generalist:main", "1", "user"),
    ]);

    const plan = await planSessionTranscriptMigration({ memoryDir });
    assert.equal(plan.files.length, 0, "legacy agent data must not be a migration source");
    assert.equal(plan.movedEntries, 0);

    const result = await migrateSessionTranscripts({ memoryDir, apply: true });
    assert.equal(result.errors.length, 0);
    const stillThere = await readFile(path.join(memoryDir, "transcripts", "main", "default", fileName), "utf-8");
    assert.equal(stillThere.split("\n").filter(Boolean).length, 1);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("migration never treats session/<hash> dirs as sources", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    const fileName = "2026-06-29.jsonl";
    const sessionKey = "pi-geek:abc123";
    const destDir = sessionStoragePaths(sessionKey).dir; // session/<hash>
    const [type, id] = destDir.split("/");
    await seedLegacyParserDir(memoryDir, type, id, fileName, [entryLine(sessionKey, "1", "user")]);

    const plan = await planSessionTranscriptMigration({ memoryDir });
    assert.equal(plan.files.length, 0, "already-homed session/<hash> must never be scanned");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("migration splits a LEGACY session/<name> dir while leaving real session/<hash> untouched", async () => {
  // Thread 3 (codex review on PR #1504): pre-#1496 the OLD parser stored a key
  // whose 3rd colon segment was literally `session` (e.g. foo:bar:session:baz)
  // under transcripts/session/baz — a NON-hash id. The new layer maps that key
  // to session/<hash>, but the migration previously BLANKET-SKIPPED everything
  // under session/, so the legacy session/baz dir was never scanned. Only the
  // canonical 16-hex session/<hash> dirs must be skipped.
  const memoryDir = await makeMemoryDir();
  try {
    const fileName = "2026-06-29.jsonl";
    const legacyKey = "foo:bar:session:baz";

    // LEGACY: OLD parser homed foo:bar:session:baz under session/baz (non-hash).
    const legacySourcePath = await seedLegacyParserDir(memoryDir, "session", "baz", fileName, [
      entryLine(legacyKey, "1", "user"),
      entryLine(legacyKey, "2", "assistant"),
    ]);

    // CANONICAL: a genuinely-homed session/<hash> dir for a different key.
    const homedKey = "pi-geek:abc123";
    const homedDir = sessionStoragePaths(homedKey).dir; // session/<16hex>
    const [homedType, homedId] = homedDir.split("/");
    assert.match(homedId, /^[0-9a-f]{16}$/);
    await seedLegacyParserDir(memoryDir, homedType, homedId, fileName, [
      entryLine(homedKey, "1", "user"),
    ]);
    const homedContentBefore = await readFile(path.join(memoryDir, "transcripts", homedDir, fileName), "utf-8");

    // Plan: only the legacy session/baz dir is a source; session/<hash> is left.
    const plan = await planSessionTranscriptMigration({ memoryDir });
    assert.equal(plan.files.length, 1, "only the legacy session/<name> dir must be a source");
    assert.equal(plan.distinctSessions, 1);
    assert.equal(plan.movedEntries, 2);
    assert.equal(plan.files[0].sourceRelPath, path.join("session", "baz", fileName));

    const result = await migrateSessionTranscripts({ memoryDir, apply: true });
    assert.equal(result.errors.length, 0);

    // Legacy data re-homed to its canonical session/<hash> dir, order preserved.
    const legacyDestDir = sessionStoragePaths(legacyKey).dir;
    assert.notEqual(legacyDestDir, path.join("session", "baz"));
    const legacyDestContent = await readFile(
      path.join(memoryDir, "transcripts", legacyDestDir, fileName),
      "utf-8",
    );
    const legacyDestLines = legacyDestContent.split("\n").filter(Boolean);
    assert.equal(legacyDestLines.length, 2);
    assert.ok(legacyDestLines[0].includes('"turnId":"1"'));
    assert.ok(legacyDestLines[1].includes('"turnId":"2"'));

    // Legacy source emptied/removed (lossless move).
    await assert.rejects(() => readFile(legacySourcePath, "utf-8"));

    // The real session/<hash> dir is byte-for-byte untouched.
    const homedContentAfter = await readFile(path.join(memoryDir, "transcripts", homedDir, fileName), "utf-8");
    assert.equal(homedContentAfter, homedContentBefore);

    // Idempotent: a second run finds nothing and does not duplicate.
    const second = await migrateSessionTranscripts({ memoryDir, apply: true });
    assert.equal(second.plan.files.length, 0);
    assert.equal(second.plan.movedEntries, 0);
    const reread = await readFile(path.join(memoryDir, "transcripts", legacyDestDir, fileName), "utf-8");
    assert.equal(reread.split("\n").filter(Boolean).length, 2);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("migration error detail is sanitized (no raw filesystem/stack message leak)", async () => {
  // Thread 2 (cursor review on PR #1504): the per-file catch must route
  // operator-facing strings (CLI output + audit manifest) through the shared
  // displayErrorDetail() sanitizer so a raw fs path or stack detail cannot leak.
  const memoryDir = await makeMemoryDir();
  try {
    const fileName = "2026-06-29.jsonl";
    // Arbitrary key routes to transcripts/session/<hash>. Planting a FILE at
    // transcripts/session makes the destination `mkdir` fail with ENOTDIR — a
    // realistic write-time failure whose raw OS message embeds an absolute path.
    await seedMixedOtherDefault(memoryDir, fileName, [entryLine("pi-geek:abc123", "1", "user")]);
    await writeFile(path.join(memoryDir, "transcripts", "session"), "blocker", "utf-8");

    const result = await migrateSessionTranscripts({ memoryDir, apply: true });

    assert.equal(result.errors.length, 1);
    const message = result.errors[0];
    // Sanitized: includes the relative source path + the error name/code only.
    assert.ok(
      message.startsWith(`Failed to migrate ${path.join("other", "default", fileName)}`),
      `unexpected error prefix: ${message}`,
    );
    assert.match(message, /\(ENOTDIR\)/);
    // Must NOT leak the raw OS message or any absolute filesystem path.
    assert.ok(!message.includes(memoryDir), "sanitized error must not leak an absolute fs path");
    assert.ok(
      !/not a directory|open '|write '/i.test(message),
      `sanitized error must not leak the raw OS message: ${message}`,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("apply writes an audit manifest", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    await seedMixedOtherDefault(memoryDir, "2026-06-29.jsonl", [entryLine("pi-geek:abc123", "1", "user")]);
    const result = await migrateSessionTranscripts({ memoryDir, apply: true });
    const manifestPath = result.manifestPath;
    assert.ok(manifestPath);
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
    assert.equal(manifest.applied, true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
