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
