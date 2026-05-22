import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ConversationChunk } from "./chunker.js";
import { cleanupConversationChunks } from "./cleanup.js";
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
  assert.match(sanitizeSessionKey("."), /^unknown-session-[a-f0-9]{12}$/);
  assert.match(sanitizeSessionKey(".."), /^unknown-session-[a-f0-9]{12}$/);
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
    assert.match(path.basename(path.dirname(path.dirname(written[0]!))), /^\.\.abc-[a-f0-9]{12}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeConversationChunks keeps distinct raw session keys from overwriting after sanitization", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-conversation-index-"));
  try {
    const written = await writeConversationChunks(root, [
      sampleChunk({
        sessionKey: "agent:main",
        id: "same-id",
        text: "colon session",
      }),
      sampleChunk({
        sessionKey: "agent_main",
        id: "same-id",
        text: "underscore session",
      }),
    ]);

    assert.equal(written.length, 2);
    assert.notEqual(written[0], written[1]);
    assert.match(path.basename(path.dirname(path.dirname(written[0]!))), /^agent_main-[a-f0-9]{12}$/);
    assert.match(path.basename(path.dirname(path.dirname(written[1]!))), /^agent_main-[a-f0-9]{12}$/);
    assert.match(await readFile(written[0]!, "utf-8"), /colon session/);
    assert.match(await readFile(written[1]!, "utf-8"), /underscore session/);
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
    for (const startTs of [
      "2026-02-31T00:00:00.000Z",
      "2026-04-31T00:00:00.000Z",
    ]) {
      await assert.rejects(
        writeConversationChunks(root, [
          sampleChunk({
            startTs,
          }),
        ]),
        /invalid conversation chunk start timestamp/,
      );
    }
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
    await symlink(outside, path.join(root, sanitizeSessionKey("agent:main")));

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
    const dir = path.join(root, sanitizeSessionKey("agent:main"), "2026-05-17");
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

test("cleanupConversationChunks rejects symlinked root without deleting target", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "remnic-conversation-index-"));
  const outside = path.join(temp, "outside");
  const root = path.join(temp, "root");
  try {
    await mkdir(path.join(outside, "session", "2000-01-01"), { recursive: true });
    await writeFile(path.join(outside, "session", "2000-01-01", "chunk.md"), "keep", "utf8");
    await symlink(outside, root);

    await cleanupConversationChunks(root, 1);

    assert.equal(
      await readFile(path.join(outside, "session", "2000-01-01", "chunk.md"), "utf8"),
      "keep",
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
