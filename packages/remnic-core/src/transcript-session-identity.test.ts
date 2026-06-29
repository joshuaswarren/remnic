import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
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

function makeEntry(sessionKey: string, turnId: string, role: "user" | "assistant"): TranscriptEntry {
  return {
    sessionKey,
    turnId,
    role,
    content: `content-${turnId}`,
    timestamp: new Date().toISOString(),
  } as TranscriptEntry;
}

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
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-tx-id-"));
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
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-tx-id-"));
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
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-tx-id-"));
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
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-tx-id-"));
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
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-tx-id-"));
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

test("legacy other/default data written by older builds remains readable", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-tx-id-"));
  try {
    // Simulate an older build that wrote an arbitrary key under other/default.
    const { mkdir, writeFile } = await import("node:fs/promises");
    const legacyDir = path.join(memoryDir, "transcripts", "other", "default");
    await mkdir(legacyDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    await writeFile(
      path.join(legacyDir, `${today}.jsonl`),
      `${JSON.stringify({
        sessionKey: "pi-legacy:zzz999",
        turnId: "1",
        role: "user",
        content: "old entry",
        timestamp: new Date().toISOString(),
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
