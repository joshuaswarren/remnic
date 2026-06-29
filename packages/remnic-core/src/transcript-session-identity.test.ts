import assert from "node:assert/strict";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TranscriptManager } from "./transcript.js";
import type { PluginConfig, TranscriptEntry } from "./types.js";

function makeConfig(memoryDir: string): PluginConfig {
  // TranscriptManager only reads memoryDir + transcriptSkipChannelTypes.
  return {
    memoryDir,
    transcriptSkipChannelTypes: [],
  } as unknown as PluginConfig;
}

// On macOS `os.tmpdir()` is a `/var/folders/...` symlink to `/private/var/...`.
// `resolveSafeStoragePath` canonicalizes via `fs.realpath`, so we canonicalize
// the test root upfront to match (issue #691 symlink convention) and to avoid a
// race where one test's recursive cleanup interleaves with another test's
// realpath traversal of the shared tmp parent.
async function makeMemoryDir(): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), "remnic-tx-id-")));
}

function makeEntry(sessionKey: string, turnId: string, role: "user" | "assistant"): TranscriptEntry {
  return {
    sessionKey,
    turnId,
    role,
    content: `content-${turnId}`,
    timestamp: new Date().toISOString(),
  } as TranscriptEntry;
}

// A timestamp comfortably INSIDE a `readRecent(48, …)` window. Seeding with the
// exact wall-clock "now" is racy: the read's upper bound is captured a moment
// after the write, and at millisecond resolution the entry's `ts` can equal the
// read's exclusive `end`, excluding a just-written row. Using a fixed offset in
// the recent past keeps these read-back assertions deterministic. The current
// day's date stamp is still used for the file name so date-window selection
// matches the directory scan.
const SEED_TS = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const TODAY = new Date().toISOString().slice(0, 10);

async function listDirs(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

test("arbitrary session keys use DIFFERENT transcript dirs on first write, never other/default", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    const tm = new TranscriptManager(makeConfig(memoryDir));
    await tm.initialize();

    await tm.append(makeEntry("pi-geek:abc123", "1", "user"));
    await tm.append(makeEntry("pi-friend:def456", "2", "user"));

    const transcriptsDir = path.join(memoryDir, "transcripts");
    const typeDirs = await listDirs(transcriptsDir);

    // First-class "session" channel type, NOT "other".
    assert.ok(typeDirs.includes("session"), `expected a session dir, got: ${typeDirs.join(",")}`);
    assert.ok(!typeDirs.includes("other"), `should not create other/, got: ${typeDirs.join(",")}`);

    // Two distinct hashed dirs under session/.
    const sessionHashes = await listDirs(path.join(transcriptsDir, "session"));
    assert.equal(sessionHashes.length, 2);
    assert.notEqual(sessionHashes[0], sessionHashes[1]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("distinct arbitrary keys never share other/default by default", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    const tm = new TranscriptManager(makeConfig(memoryDir));
    await tm.initialize();

    await tm.append(makeEntry("pi-geek:abc123", "1", "user"));
    await tm.append(makeEntry("pi-friend:def456", "2", "user"));

    // Each key only reads back its OWN entries.
    const geek = await tm.readRecent(48, "pi-geek:abc123");
    const friend = await tm.readRecent(48, "pi-friend:def456");
    assert.equal(geek.length, 1);
    assert.equal(friend.length, 1);
    assert.equal(geek[0].sessionKey, "pi-geek:abc123");
    assert.equal(friend[0].sessionKey, "pi-friend:def456");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("legacy agent:<id>:main keeps its readable main/default path", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    const tm = new TranscriptManager(makeConfig(memoryDir));
    await tm.initialize();

    await tm.append(makeEntry("agent:generalist:main", "1", "user"));

    const transcriptsDir = path.join(memoryDir, "transcripts");
    const typeDirs = await listDirs(transcriptsDir);
    assert.ok(typeDirs.includes("main"), `expected main dir, got: ${typeDirs.join(",")}`);

    const idDirs = await listDirs(path.join(transcriptsDir, "main"));
    assert.deepEqual(idDirs, ["default"]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("tool usage for arbitrary keys routes to state/tool-usage/session/<hash>", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    const tm = new TranscriptManager(makeConfig(memoryDir));
    await tm.initialize();

    await tm.appendToolUse({
      timestamp: new Date().toISOString(),
      sessionKey: "pi-geek:abc123",
      tool: "search",
    });

    const toolUsageDir = path.join(memoryDir, "state", "tool-usage");
    const typeDirs = await listDirs(toolUsageDir);
    assert.ok(typeDirs.includes("session"), `expected session tool-usage dir, got: ${typeDirs.join(",")}`);
    assert.ok(!typeDirs.includes("other"));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("listSessionKeys discovers BOTH legacy and hashed arbitrary sessions", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    const tm = new TranscriptManager(makeConfig(memoryDir));
    await tm.initialize();

    await tm.append(makeEntry("agent:generalist:main", "1", "user"));
    await tm.append(makeEntry("pi-geek:abc123", "2", "user"));
    await tm.append(makeEntry("pi-friend:def456", "3", "user"));

    const keys = (await tm.listSessionKeys()).sort();
    assert.deepEqual(keys, ["agent:generalist:main", "pi-friend:def456", "pi-geek:abc123"]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

async function writeJsonl(absDir: string, fileName: string, lines: string[]): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(absDir, { recursive: true });
  await writeFile(path.join(absDir, fileName), `${lines.join("\n")}\n`, "utf-8");
}

test("partial migration (copied-but-not-trimmed) yields each transcript row exactly once", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    const sessionKey = "pi-geek:abc123";
    // Same byte-identical row present in BOTH the primary session/<hash> dir and
    // the legacy other/default dir — the state left by a migration that copied
    // to the destination but crashed before trimming the source.
    const row = JSON.stringify({
      sessionKey,
      turnId: "1",
      role: "user",
      content: "duplicated row",
      timestamp: SEED_TS,
    });

    const { sessionStoragePaths } = await import("./session-identity.js");
    const primaryDir = path.join(memoryDir, "transcripts", sessionStoragePaths(sessionKey).dir);
    const otherDefaultDir = path.join(memoryDir, "transcripts", "other", "default");
    await writeJsonl(primaryDir, `${TODAY}.jsonl`, [row]);
    await writeJsonl(otherDefaultDir, `${TODAY}.jsonl`, [row]);

    const tm = new TranscriptManager(makeConfig(memoryDir));
    await tm.initialize();

    const entries = await tm.readRecent(48, sessionKey);
    assert.equal(entries.length, 1, "duplicated row must be returned exactly once");
    assert.equal(entries[0].content, "duplicated row");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("partial migration yields each tool-usage row exactly once", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    const sessionKey = "pi-geek:abc123";
    const row = JSON.stringify({ sessionKey, tool: "search", timestamp: SEED_TS });

    const { sessionStoragePaths } = await import("./session-identity.js");
    const primaryDir = path.join(memoryDir, "state", "tool-usage", sessionStoragePaths(sessionKey).dir);
    const otherDefaultDir = path.join(memoryDir, "state", "tool-usage", "other", "default");
    await writeJsonl(primaryDir, `${TODAY}.jsonl`, [row]);
    await writeJsonl(otherDefaultDir, `${TODAY}.jsonl`, [row]);

    const tm = new TranscriptManager(makeConfig(memoryDir));
    await tm.initialize();

    const start = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const end = new Date(Date.now() + 60 * 60 * 1000);
    const used = await tm.readToolUse(sessionKey, start, end);
    assert.equal(used.length, 1, "duplicated tool-usage row must be returned exactly once");
    assert.equal(used[0].tool, "search");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("pre-existing foo:bar:baz data under old baz/default stays readable", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    // An OLD build (parts.length >= 3, no leading `agent`) stored foo:bar:baz
    // under baz/default. The NEW parser reclassifies it as session/<hash>, but
    // the old data must remain visible via the legacy-parser read-back dir.
    const sessionKey = "foo:bar:baz";
    const oldDir = path.join(memoryDir, "transcripts", "baz", "default");
    await writeJsonl(oldDir, `${TODAY}.jsonl`, [
      JSON.stringify({ sessionKey, turnId: "1", role: "user", content: "old baz entry", timestamp: SEED_TS }),
    ]);
    // Tool-usage equivalent.
    const oldToolDir = path.join(memoryDir, "state", "tool-usage", "baz", "default");
    await writeJsonl(oldToolDir, `${TODAY}.jsonl`, [
      JSON.stringify({ sessionKey, tool: "grep", timestamp: SEED_TS }),
    ]);

    const tm = new TranscriptManager(makeConfig(memoryDir));
    await tm.initialize();

    const entries = await tm.readRecent(48, sessionKey);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].content, "old baz entry");

    const start = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const end = new Date(Date.now() + 60 * 60 * 1000);
    const used = await tm.readToolUse(sessionKey, start, end);
    assert.equal(used.length, 1);
    assert.equal(used[0].tool, "grep");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("pre-existing foo:bar:baz:qux data under old baz/qux stays readable", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    const sessionKey = "foo:bar:baz:qux";
    const oldDir = path.join(memoryDir, "transcripts", "baz", "qux");
    await writeJsonl(oldDir, `${TODAY}.jsonl`, [
      JSON.stringify({ sessionKey, turnId: "1", role: "user", content: "old baz/qux entry", timestamp: SEED_TS }),
    ]);

    const tm = new TranscriptManager(makeConfig(memoryDir));
    await tm.initialize();

    const entries = await tm.readRecent(48, sessionKey);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].content, "old baz/qux entry");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("partial migration across legacy baz/default and session/<hash> dedupes to one row", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    const sessionKey = "foo:bar:baz";
    const row = JSON.stringify({
      sessionKey,
      turnId: "1",
      role: "user",
      content: "shared legacy row",
      timestamp: SEED_TS,
    });
    const { sessionStoragePaths } = await import("./session-identity.js");
    const primaryDir = path.join(memoryDir, "transcripts", sessionStoragePaths(sessionKey).dir);
    const legacyDir = path.join(memoryDir, "transcripts", "baz", "default");
    await writeJsonl(primaryDir, `${TODAY}.jsonl`, [row]);
    await writeJsonl(legacyDir, `${TODAY}.jsonl`, [row]);

    const tm = new TranscriptManager(makeConfig(memoryDir));
    await tm.initialize();

    const entries = await tm.readRecent(48, sessionKey);
    assert.equal(entries.length, 1, "row shared across legacy and primary dir must dedupe to one");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("legacy other/default data written by older builds remains readable", async () => {
  const memoryDir = await makeMemoryDir();
  try {
    // Simulate an older build that wrote an arbitrary key under other/default.
    const { mkdir, writeFile } = await import("node:fs/promises");
    const legacyDir = path.join(memoryDir, "transcripts", "other", "default");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      path.join(legacyDir, `${TODAY}.jsonl`),
      `${JSON.stringify({
        sessionKey: "pi-legacy:zzz999",
        turnId: "1",
        role: "user",
        content: "old entry",
        timestamp: SEED_TS,
      })}\n`,
      "utf-8"
    );

    const tm = new TranscriptManager(makeConfig(memoryDir));
    await tm.initialize();

    // listSessionKeys must still surface the legacy-stored key.
    const keys = await tm.listSessionKeys();
    assert.ok(keys.includes("pi-legacy:zzz999"));

    // readRecent must still read it (alternateDir/legacy read-back path).
    const entries = await tm.readRecent(48, "pi-legacy:zzz999");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].content, "old entry");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
