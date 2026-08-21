import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseConfig } from "../src/config.js";
import { TranscriptManager } from "../src/transcript.js";

async function assertPathMissing(filePath: string): Promise<void> {
  await assert.rejects(access(filePath), { code: "ENOENT" });
}

async function writeJsonl(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value)}\n`, "utf-8");
}

test("transcript append encodes session path components before writing", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-transcript-path-"));
  try {
    const transcript = new TranscriptManager(parseConfig({
      memoryDir,
      transcriptEnabled: true,
      transcriptSkipChannelTypes: [],
    }));
    await transcript.initialize();

    const sessionKey = "agent:bot:../escape:channel";
    await transcript.append({
      timestamp: "2026-05-16T12:00:00.000Z",
      role: "user",
      content: "hello",
      sessionKey,
      turnId: "turn-1",
    });

    const { dir, file } = transcript.getTranscriptPath(sessionKey);
    const transcriptRoot = path.join(memoryDir, "transcripts");
    const storedPath = path.join(transcriptRoot, dir, file);
    const relativePath = path.relative(transcriptRoot, storedPath);
    assert.equal(relativePath.startsWith(".."), false);
    assert.match(relativePath, /^%2E%2E%2Fescape\/channel\//);

    const raw = await readFile(storedPath, "utf-8");
    assert.match(raw, /"sessionKey":"agent:bot:\.\.\/escape:channel"/);
    await assertPathMissing(path.join(memoryDir, "escape", "channel", file));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("tool-use append encodes session path components before writing", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-tool-path-"));
  try {
    const transcript = new TranscriptManager(parseConfig({
      memoryDir,
      transcriptEnabled: true,
      transcriptSkipChannelTypes: [],
    }));
    await transcript.initialize();

    const sessionKey = "agent:bot:discord:channel:../../tool-escape";
    await transcript.appendToolUse({
      timestamp: "2026-05-16T12:00:00.000Z",
      sessionKey,
      tool: "memory_search",
    });

    const { dir, file } = transcript.getToolUsagePath(sessionKey);
    const toolRoot = path.join(memoryDir, "state", "tool-usage");
    const storedPath = path.join(toolRoot, dir, file);
    const relativePath = path.relative(toolRoot, storedPath);
    assert.equal(relativePath.startsWith(".."), false);
    assert.match(relativePath, /^discord\/%2E%2E%2F%2E%2E%2Ftool-escape\//);

    const raw = await readFile(storedPath, "utf-8");
    assert.match(raw, /"tool":"memory_search"/);
    await assertPathMissing(path.join(memoryDir, "state", "tool-escape", file));

    const entries = await transcript.readToolUse(
      sessionKey,
      new Date("2026-05-16T11:59:00.000Z"),
      new Date("2026-05-16T12:01:00.000Z"),
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.sessionKey, sessionKey);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("transcript skip channel types compare raw channel names", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-transcript-skip-"));
  try {
    const transcript = new TranscriptManager(parseConfig({
      memoryDir,
      transcriptEnabled: true,
      transcriptSkipChannelTypes: ["custom.type"],
    }));
    await transcript.initialize();

    const sessionKey = "agent:bot:custom.type:channel-1";
    const { dir, file } = transcript.getTranscriptPath(sessionKey);

    await transcript.append({
      timestamp: "2026-05-16T12:00:00.000Z",
      role: "user",
      content: "skip this",
      sessionKey,
      turnId: "turn-1",
    });

    await assertPathMissing(path.join(memoryDir, "transcripts", dir, file));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("safe legacy transcript directories remain readable and writable", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-transcript-legacy-"));
  try {
    const transcript = new TranscriptManager(parseConfig({
      memoryDir,
      transcriptEnabled: true,
    }));
    await transcript.initialize();

    const sessionKey = "agent:bot:custom:nightly.summary";
    const now = new Date();
    const { dir, file } = transcript.getTranscriptPath(sessionKey);
    const legacyDir = path.join(memoryDir, "transcripts", "custom", "nightly.summary");
    await mkdir(legacyDir, { recursive: true });
    await writeJsonl(path.join(legacyDir, file), {
      timestamp: now.toISOString(),
      role: "user",
      content: "legacy transcript entry",
      sessionKey,
      turnId: "legacy-turn",
    });

    const footprint = await transcript.estimateSessionFootprint(sessionKey);
    assert.ok(footprint.bytes > 0);

    const entries = await transcript.readRecent(1, sessionKey);
    assert.deepEqual(entries.map((entry) => entry.turnId), ["legacy-turn"]);

    await transcript.append({
      timestamp: now.toISOString(),
      role: "assistant",
      content: "new transcript entry",
      sessionKey,
      turnId: "new-turn",
    });

    const raw = await readFile(path.join(legacyDir, file), "utf-8");
    assert.match(raw, /legacy transcript entry/);
    assert.match(raw, /new transcript entry/);
    await assertPathMissing(path.join(memoryDir, "transcripts", dir, file));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("safe legacy tool-use directories remain readable and writable", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-tool-legacy-"));
  try {
    const transcript = new TranscriptManager(parseConfig({
      memoryDir,
      transcriptEnabled: true,
    }));
    await transcript.initialize();

    const sessionKey = "agent:bot:custom:nightly.summary";
    const timestamp = new Date().toISOString();
    const { dir, file } = transcript.getToolUsagePath(sessionKey);
    const legacyDir = path.join(memoryDir, "state", "tool-usage", "custom", "nightly.summary");
    await mkdir(legacyDir, { recursive: true });
    await writeJsonl(path.join(legacyDir, file), {
      timestamp,
      sessionKey,
      tool: "memory_search",
    });

    const before = await transcript.readToolUse(
      sessionKey,
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 60_000),
    );
    assert.deepEqual(before.map((entry) => entry.tool), ["memory_search"]);

    await transcript.appendToolUse({
      timestamp,
      sessionKey,
      tool: "memory_store",
    });

    const raw = await readFile(path.join(legacyDir, file), "utf-8");
    assert.match(raw, /memory_search/);
    assert.match(raw, /memory_store/);
    await assertPathMissing(path.join(memoryDir, "state", "tool-usage", dir, file));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("encoded-looking session IDs do not reuse colliding legacy transcript directories", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-transcript-collision-"));
  try {
    const transcript = new TranscriptManager(parseConfig({
      memoryDir,
      transcriptEnabled: true,
    }));
    await transcript.initialize();

    const ownerSessionKey = "agent:bot:custom:nightly.summary";
    const collidingSessionKey = "agent:bot:custom:nightly%2Esummary";
    const timestamp = new Date().toISOString();
    const { dir: ownerDir, file } = transcript.getTranscriptPath(ownerSessionKey);
    const { dir: collidingDir } = transcript.getTranscriptPath(collidingSessionKey);
    const ownerTranscriptDir = path.join(memoryDir, "transcripts", ownerDir);
    const ownerToolDir = path.join(memoryDir, "state", "tool-usage", ownerDir);
    await mkdir(ownerTranscriptDir, { recursive: true });
    await mkdir(ownerToolDir, { recursive: true });
    await writeJsonl(path.join(ownerTranscriptDir, file), {
      timestamp,
      role: "user",
      content: "owner transcript entry",
      sessionKey: ownerSessionKey,
      turnId: "owner-turn",
    });
    await writeJsonl(path.join(ownerToolDir, file), {
      timestamp,
      sessionKey: ownerSessionKey,
      tool: "owner_tool",
    });

    assert.equal(ownerDir, "custom/nightly%2Esummary");
    assert.equal(collidingDir, "custom/nightly%252Esummary");
    assert.deepEqual(await transcript.readRecent(1, collidingSessionKey), []);
    assert.deepEqual(
      await transcript.readToolUse(
        collidingSessionKey,
        new Date(Date.now() - 60_000),
        new Date(Date.now() + 60_000),
      ),
      [],
    );

    await transcript.append({
      timestamp,
      role: "assistant",
      content: "colliding transcript entry",
      sessionKey: collidingSessionKey,
      turnId: "colliding-turn",
    });
    await transcript.appendToolUse({
      timestamp,
      sessionKey: collidingSessionKey,
      tool: "colliding_tool",
    });

    const ownerTranscriptRaw = await readFile(path.join(ownerTranscriptDir, file), "utf-8");
    const collidingTranscriptRaw = await readFile(
      path.join(memoryDir, "transcripts", collidingDir, file),
      "utf-8",
    );
    const ownerToolRaw = await readFile(path.join(ownerToolDir, file), "utf-8");
    const collidingToolRaw = await readFile(
      path.join(memoryDir, "state", "tool-usage", collidingDir, file),
      "utf-8",
    );

    assert.match(ownerTranscriptRaw, /owner transcript entry/);
    assert.doesNotMatch(ownerTranscriptRaw, /colliding transcript entry/);
    assert.match(collidingTranscriptRaw, /colliding transcript entry/);
    assert.match(ownerToolRaw, /owner_tool/);
    assert.doesNotMatch(ownerToolRaw, /colliding_tool/);
    assert.match(collidingToolRaw, /colliding_tool/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("transcript append does not reuse encoded directories occupied by another session", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-transcript-encoded-collision-"));
  try {
    const transcript = new TranscriptManager(parseConfig({
      memoryDir,
      transcriptEnabled: true,
    }));
    await transcript.initialize();

    const legacyPercentSessionKey = "agent:bot:custom:nightly%2Esummary";
    const encodedDotSessionKey = "agent:bot:custom:nightly.summary";
    const timestamp = new Date().toISOString();
    const { dir, file, alternateDir } = transcript.getTranscriptPath(encodedDotSessionKey);
    const occupiedTranscriptDir = path.join(memoryDir, "transcripts", dir);
    const occupiedToolDir = path.join(memoryDir, "state", "tool-usage", dir);
    await mkdir(occupiedTranscriptDir, { recursive: true });
    await mkdir(occupiedToolDir, { recursive: true });
    await writeJsonl(path.join(occupiedTranscriptDir, file), {
      timestamp,
      role: "user",
      content: "legacy percent transcript entry",
      sessionKey: legacyPercentSessionKey,
      turnId: "legacy-percent-turn",
    });
    await writeJsonl(path.join(occupiedToolDir, file), {
      timestamp,
      sessionKey: legacyPercentSessionKey,
      tool: "legacy_percent_tool",
    });

    await transcript.append({
      timestamp,
      role: "assistant",
      content: "encoded dot transcript entry",
      sessionKey: encodedDotSessionKey,
      turnId: "encoded-dot-turn",
    });
    await transcript.appendToolUse({
      timestamp,
      sessionKey: encodedDotSessionKey,
      tool: "encoded_dot_tool",
    });

    const occupiedTranscriptRaw = await readFile(path.join(occupiedTranscriptDir, file), "utf-8");
    const alternateTranscriptRaw = await readFile(
      path.join(memoryDir, "transcripts", alternateDir, file),
      "utf-8",
    );
    const occupiedToolRaw = await readFile(path.join(occupiedToolDir, file), "utf-8");
    const alternateToolRaw = await readFile(
      path.join(memoryDir, "state", "tool-usage", alternateDir, file),
      "utf-8",
    );

    assert.match(occupiedTranscriptRaw, /legacy percent transcript entry/);
    assert.doesNotMatch(occupiedTranscriptRaw, /encoded dot transcript entry/);
    assert.match(alternateTranscriptRaw, /encoded dot transcript entry/);
    assert.match(occupiedToolRaw, /legacy_percent_tool/);
    assert.doesNotMatch(occupiedToolRaw, /encoded_dot_tool/);
    assert.match(alternateToolRaw, /encoded_dot_tool/);
    assert.deepEqual(
      (await transcript.readRecent(1, encodedDotSessionKey)).map((entry) => entry.turnId),
      ["encoded-dot-turn"],
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("transcript append treats mixed session directories as occupied", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-transcript-mixed-collision-"));
  try {
    const transcript = new TranscriptManager(parseConfig({
      memoryDir,
      transcriptEnabled: true,
    }));
    await transcript.initialize();

    const otherSessionKey = "agent:bot:custom:nightly%2Esummary";
    const sessionKey = "agent:bot:custom:nightly.summary";
    const timestamp = new Date().toISOString();
    const { dir, file, alternateDir } = transcript.getTranscriptPath(sessionKey);
    const mixedTranscriptDir = path.join(memoryDir, "transcripts", dir);
    await mkdir(mixedTranscriptDir, { recursive: true });
    await writeFile(
      path.join(mixedTranscriptDir, file),
      `${JSON.stringify({
        timestamp,
        role: "user",
        content: "current session existing entry",
        sessionKey,
        turnId: "current-existing-turn",
      })}\n${JSON.stringify({
        timestamp,
        role: "user",
        content: "other session entry",
        sessionKey: otherSessionKey,
        turnId: "other-turn",
      })}\n`,
      "utf-8",
    );

    await transcript.append({
      timestamp,
      role: "assistant",
      content: "current session new entry",
      sessionKey,
      turnId: "current-new-turn",
    });

    const mixedRaw = await readFile(path.join(mixedTranscriptDir, file), "utf-8");
    const alternateRaw = await readFile(
      path.join(memoryDir, "transcripts", alternateDir, file),
      "utf-8",
    );
    assert.match(mixedRaw, /current session existing entry/);
    assert.match(mixedRaw, /other session entry/);
    assert.doesNotMatch(mixedRaw, /current session new entry/);
    assert.match(alternateRaw, /current session new entry/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("transcript append invalidates ownership cache when a directory changes", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-transcript-cache-collision-"));
  try {
    const transcript = new TranscriptManager(parseConfig({
      memoryDir,
      transcriptEnabled: true,
    }));
    await transcript.initialize();

    const otherSessionKey = "agent:bot:custom:nightly%2Esummary";
    const sessionKey = "agent:bot:custom:nightly.summary";
    const timestamp = new Date().toISOString();
    const { dir, file, alternateDir } = transcript.getTranscriptPath(sessionKey);
    const transcriptDir = path.join(memoryDir, "transcripts", dir);

    await transcript.append({
      timestamp,
      role: "user",
      content: "first current entry",
      sessionKey,
      turnId: "first-current-turn",
    });

    const transcriptPath = path.join(transcriptDir, file);
    const originalRaw = await readFile(transcriptPath, "utf-8");
    await writeFile(
      transcriptPath,
      `${originalRaw}${JSON.stringify({
        timestamp,
        role: "user",
        content: "externally mixed entry",
        sessionKey: otherSessionKey,
        turnId: "external-other-turn",
      })}\n`,
      "utf-8",
    );

    await transcript.append({
      timestamp,
      role: "assistant",
      content: "second current entry",
      sessionKey,
      turnId: "second-current-turn",
    });

    const mixedRaw = await readFile(transcriptPath, "utf-8");
    const alternateRaw = await readFile(
      path.join(memoryDir, "transcripts", alternateDir, file),
      "utf-8",
    );
    assert.match(mixedRaw, /first current entry/);
    assert.match(mixedRaw, /externally mixed entry/);
    assert.doesNotMatch(mixedRaw, /second current entry/);
    assert.match(alternateRaw, /second current entry/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("alternate transcript directories are session-specific for shared channels", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-transcript-shared-channel-"));
  try {
    const transcript = new TranscriptManager(parseConfig({
      memoryDir,
      transcriptEnabled: true,
    }));
    await transcript.initialize();

    const timestamp = new Date().toISOString();
    const sessionKeys = ["agent:alpha:main", "agent:beta:main", "agent:gamma:main"];
    const alternateDirs = sessionKeys.map((sessionKey) => (
      transcript.getTranscriptPath(sessionKey).alternateDir
    ));
    assert.equal(new Set(alternateDirs).size, sessionKeys.length);

    for (const [index, sessionKey] of sessionKeys.entries()) {
      await transcript.append({
        timestamp,
        role: "user",
        content: `shared channel transcript ${index}`,
        sessionKey,
        turnId: `shared-turn-${index}`,
      });
      await transcript.appendToolUse({
        timestamp,
        sessionKey,
        tool: `shared_tool_${index}`,
      });
    }

    for (const [index, sessionKey] of sessionKeys.entries()) {
      const entries = await transcript.readRecent(1, sessionKey);
      assert.deepEqual(entries.map((entry) => entry.turnId), [`shared-turn-${index}`]);
      const tools = await transcript.readToolUse(
        sessionKey,
        new Date(Date.now() - 60_000),
        new Date(Date.now() + 60_000),
      );
      assert.deepEqual(tools.map((entry) => entry.tool), [`shared_tool_${index}`]);
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("transcript and tool-use reads skip symlinked jsonl files", async (t) => {
  if (process.platform === "win32") {
    t.skip("file symlink setup is platform-specific");
    return;
  }

  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-jsonl-symlink-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "engram-jsonl-outside-"));
  try {
    const transcript = new TranscriptManager(parseConfig({
      memoryDir,
      transcriptEnabled: true,
    }));
    await transcript.initialize();

    const sessionKey = "agent:bot:main";
    const timestamp = new Date().toISOString();
    const { dir, file } = transcript.getTranscriptPath(sessionKey);
    const transcriptDir = path.join(memoryDir, "transcripts", dir);
    await mkdir(transcriptDir, { recursive: true });
    const outsideTranscript = path.join(outsideDir, "outside-transcript.jsonl");
    await writeJsonl(outsideTranscript, {
      timestamp,
      role: "user",
      content: "outside transcript",
      sessionKey,
      turnId: "outside-turn",
    });
    await symlink(outsideTranscript, path.join(transcriptDir, file), "file");

    const toolDir = path.join(memoryDir, "state", "tool-usage", dir);
    await mkdir(toolDir, { recursive: true });
    const outsideToolUse = path.join(outsideDir, "outside-tool.jsonl");
    await writeJsonl(outsideToolUse, {
      timestamp,
      sessionKey,
      tool: "memory_search",
    });
    await symlink(outsideToolUse, path.join(toolDir, file), "file");

    assert.deepEqual(await transcript.readRecent(1, sessionKey), []);
    assert.deepEqual(
      await transcript.readToolUse(
        sessionKey,
        new Date(Date.now() - 60_000),
        new Date(Date.now() + 60_000),
      ),
      [],
    );
    assert.equal((await transcript.estimateSessionFootprint(sessionKey)).bytes, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("transcript append rejects symlinked channel ancestors", async (t) => {
  if (process.platform === "win32") {
    t.skip("directory symlink setup is platform-specific");
    return;
  }

  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-transcript-symlink-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "engram-transcript-outside-"));
  try {
    const transcript = new TranscriptManager(parseConfig({
      memoryDir,
      transcriptEnabled: true,
    }));
    await transcript.initialize();
    await symlink(outsideDir, path.join(memoryDir, "transcripts", "discord"), "dir");

    const sessionKey = "agent:bot:discord:channel:secret";
    const { file } = transcript.getTranscriptPath(sessionKey);

    await assert.rejects(
      transcript.append({
        timestamp: "2026-05-16T12:00:00.000Z",
        role: "user",
        content: "hello",
        sessionKey,
        turnId: "turn-1",
      }),
      /symlink/i,
    );
    await assertPathMissing(path.join(outsideDir, "secret", file));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("tool-use append rejects symlinked tool roots", async (t) => {
  if (process.platform === "win32") {
    t.skip("directory symlink setup is platform-specific");
    return;
  }

  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-tool-symlink-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "engram-tool-outside-"));
  try {
    const transcript = new TranscriptManager(parseConfig({
      memoryDir,
      transcriptEnabled: true,
    }));
    await transcript.initialize();
    await rm(path.join(memoryDir, "state", "tool-usage"), { recursive: true, force: true });
    await mkdir(path.join(memoryDir, "state"), { recursive: true });
    await symlink(outsideDir, path.join(memoryDir, "state", "tool-usage"), "dir");

    const sessionKey = "agent:bot:main";
    const { file } = transcript.getToolUsagePath(sessionKey);

    await assert.rejects(
      transcript.appendToolUse({
        timestamp: "2026-05-16T12:00:00.000Z",
        sessionKey,
        tool: "memory_search",
      }),
      /symlink/i,
    );
    await assertPathMissing(path.join(outsideDir, "main", "default", file));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("tool-use append rejects symlinked state ancestors before root exists", async (t) => {
  if (process.platform === "win32") {
    t.skip("directory symlink setup is platform-specific");
    return;
  }

  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-tool-parent-symlink-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "engram-tool-parent-outside-"));
  try {
    await symlink(outsideDir, path.join(memoryDir, "state"), "dir");

    const transcript = new TranscriptManager(parseConfig({
      memoryDir,
      transcriptEnabled: true,
    }));
    const sessionKey = "agent:bot:main";
    const { file } = transcript.getToolUsagePath(sessionKey);

    await assert.rejects(
      transcript.appendToolUse({
        timestamp: "2026-05-16T12:00:00.000Z",
        sessionKey,
        tool: "memory_search",
      }),
      /symlink/i,
    );
    await assertPathMissing(path.join(outsideDir, "tool-usage", "main", "default", file));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});
