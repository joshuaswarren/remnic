import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ConversationChunk } from "./chunker.js";
import { sanitizeSessionKey, writeConversationChunks } from "./indexer.js";

function sampleChunk(overrides: Partial<ConversationChunk> = {}): ConversationChunk {
  return {
    id: "2026-05-17T00-00-00-000Z-0",
    sessionKey: "agent:main",
    startTs: "2026-05-17T00:00:00.000Z",
    endTs: "2026-05-17T00:01:00.000Z",
    text: "hello",
    ...overrides,
  };
}

function assertInsideRoot(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  assert.ok(relative.length > 0);
  assert.notEqual(relative, "..", `${candidate} escaped ${root}`);
  assert.ok(!relative.startsWith(`..${path.sep}`), `${candidate} escaped ${root}`);
  assert.ok(!path.isAbsolute(relative), `${candidate} escaped ${root}`);
}

test("sanitizeSessionKey rejects dot-only path components", () => {
  assert.equal(sanitizeSessionKey("."), "unknown-session");
  assert.equal(sanitizeSessionKey(".."), "unknown-session");
  assert.equal(sanitizeSessionKey(""), "unknown-session");
});

test("writeConversationChunks keeps adversarial path components inside root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-conversation-index-"));
  try {
    const written = await writeConversationChunks(root, [
      sampleChunk({
        id: "../../outside",
        sessionKey: "..",
      }),
    ]);

    assert.equal(written.length, 1);
    assertInsideRoot(root, written[0]!);
    assert.equal(path.basename(written[0]!), ".._.._outside.md");
    assert.match(await readFile(written[0]!, "utf-8"), /kind: conversation_chunk/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeConversationChunks accepts safe dot-prefixed path components", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-conversation-index-"));
  try {
    const written = await writeConversationChunks(root, [
      sampleChunk({
        id: "..chunk",
        sessionKey: "..abc",
      }),
    ]);

    assert.equal(written.length, 1);
    assertInsideRoot(root, written[0]!);
    assert.equal(path.basename(written[0]!), "..chunk.md");
    assert.equal(path.basename(path.dirname(path.dirname(written[0]!))), "..abc");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeConversationChunks rejects invalid chunk timestamps before deriving paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-conversation-index-"));
  try {
    await assert.rejects(
      writeConversationChunks(root, [
        sampleChunk({
          startTs: "../2026-05-17",
        }),
      ]),
      /invalid conversation chunk start timestamp/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeConversationChunks rejects a symlinked index root", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "remnic-conversation-index-"));
  const target = path.join(temp, "outside");
  const root = path.join(temp, "index-root");
  try {
    await mkdir(target);
    await symlink(target, root);

    await assert.rejects(
      writeConversationChunks(root, [sampleChunk()]),
      /conversation chunk path contains symlink/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("writeConversationChunks rejects symlinked root ancestors before mkdir", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "remnic-conversation-index-"));
  const memoryDir = path.join(temp, "memory");
  const stateTarget = path.join(temp, "outside-state");
  const root = path.join(memoryDir, "state", "conversation-index");
  try {
    await mkdir(memoryDir);
    await mkdir(stateTarget);
    await symlink(stateTarget, path.join(memoryDir, "state"));

    await assert.rejects(
      writeConversationChunks(root, [sampleChunk()]),
      /conversation chunk path contains symlink/,
    );
    await assert.rejects(access(path.join(stateTarget, "conversation-index")), {
      code: "ENOENT",
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("writeConversationChunks rejects symlinked intermediate directories", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "remnic-conversation-index-"));
  const root = path.join(temp, "root");
  const outside = path.join(temp, "outside");
  try {
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, path.join(root, "agent_main"));

    await assert.rejects(
      writeConversationChunks(root, [sampleChunk({ sessionKey: "agent:main" })]),
      /conversation chunk path contains symlink/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("writeConversationChunks rejects symlinked target files", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "remnic-conversation-index-"));
  const root = path.join(temp, "root");
  const outside = path.join(temp, "outside.md");
  const chunk = sampleChunk({ id: "chunk-1" });
  try {
    const dir = path.join(root, "agent_main", "2026-05-17");
    await mkdir(dir, { recursive: true });
    await writeFile(outside, "outside", "utf-8");
    await symlink(outside, path.join(dir, "chunk-1.md"));

    await assert.rejects(
      writeConversationChunks(root, [chunk]),
      /conversation chunk path contains symlink/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
