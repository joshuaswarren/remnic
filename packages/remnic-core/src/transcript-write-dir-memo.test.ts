import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { parseConfig } from "./config.js";
import { JsonlOwnershipDigestCache } from "./transcript-ownership-digest.js";
import { WriteDirMemo } from "./transcript-write-dir-memo.js";
import { TranscriptManager } from "./transcript.js";
import type { TranscriptEntry } from "./types.js";

async function withManager(
  fn: (ctx: { manager: TranscriptManager; root: string }) => Promise<void>,
): Promise<void> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-transcript-memo-"));
  try {
    const manager = new TranscriptManager(parseConfig({ memoryDir }));
    await manager.initialize();
    await fn({ manager, root: path.join(memoryDir, "transcripts") });
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
}

function entry(sessionKey: string, turnId: string): TranscriptEntry {
  return { timestamp: new Date().toISOString(), role: "user", content: `turn ${turnId}`, sessionKey, turnId };
}

/** Write `days` old daily files, each holding one row owned by `sessionKey`. */
async function writeOldDays(channelDir: string, sessionKey: string, days: number): Promise<void> {
  await mkdir(channelDir, { recursive: true });
  for (let day = 1; day <= days; day++) {
    const date = new Date(Date.UTC(2026, 0, day)).toISOString().slice(0, 10);
    await writeFile(path.join(channelDir, `${date}.jsonl`), `${JSON.stringify(entry(sessionKey, `old${day}`))}\n`, "utf-8");
  }
}

async function jsonlContents(dir: string): Promise<string> {
  const names = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith(".jsonl")).sort();
  return (await Promise.all(names.map((n) => readFile(path.join(dir, n), "utf-8")))).join("");
}

test("a session's later appends do not re-read its old daily files", async () => {
  await withManager(async ({ manager, root }) => {
    const owner = "pi-geek:memo-steady";
    const channelDir = path.join(root, manager.getTranscriptPath(owner).dir);
    await writeOldDays(channelDir, owner, 5);
    const verify = mock.method(JsonlOwnershipDigestCache.prototype, "verify");
    try {
      await manager.append(entry(owner, "a1"));
      assert.equal(verify.mock.callCount(), 5, "the first append verifies the directory once");
      verify.mock.resetCalls();
      await manager.append(entry(owner, "a2"));
      await manager.append(entry(owner, "a3"));
      assert.equal(verify.mock.callCount(), 0, "later appends re-verified the directory");
    } finally {
      verify.mock.restore();
    }
    const text = await jsonlContents(channelDir);
    for (const id of ["a1", "a2", "a3"]) assert.ok(text.includes(`"turnId":"${id}"`), `${id} was not written`);
  });
});

test("a directory holding another session's rows is still refused on the first append", async () => {
  await withManager(async ({ manager, root }) => {
    const owner = "pi-geek:memo-owner";
    const intruder = "pi-geek:memo-intrude";
    const { dir, alternateDir } = manager.getTranscriptPath(owner);
    await writeOldDays(path.join(root, dir), intruder, 2);
    await manager.append(entry(owner, "b1"));
    await manager.append(entry(owner, "b2"));
    assert.equal((await jsonlContents(path.join(root, dir))).includes('"turnId":"b1"'), false, "wrote into a foreign directory");
    const alternate = await jsonlContents(path.join(root, alternateDir));
    assert.ok(alternate.includes('"turnId":"b1"') && alternate.includes('"turnId":"b2"'));
  });
});

test("an append error drops the remembered directory so the next append verifies it again", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root bypasses file permissions");
    return;
  }
  await withManager(async ({ manager, root }) => {
    const owner = "pi-geek:memo-error";
    const { dir, file } = manager.getTranscriptPath(owner);
    const channelDir = path.join(root, dir);
    await writeOldDays(channelDir, owner, 3);
    await manager.append(entry(owner, "c1"));
    // A read-only daily file lets the directory check pass and makes appendFile fail.
    const today = path.join(channelDir, file);
    await chmod(today, 0o444);
    await assert.rejects(manager.append(entry(owner, "c2")));
    await chmod(today, 0o644);
    const verify = mock.method(JsonlOwnershipDigestCache.prototype, "verify");
    try {
      await manager.append(entry(owner, "c3"));
      assert.ok(verify.mock.callCount() >= 3, "the directory was not verified again after the error");
    } finally {
      verify.mock.restore();
    }
  });
});

test("each session keeps its own remembered directory", async () => {
  await withManager(async ({ manager, root }) => {
    const a = "pi-geek:memo-a";
    const b = "pi-geek:memo-b";
    await writeOldDays(path.join(root, manager.getTranscriptPath(a).dir), a, 2);
    await writeOldDays(path.join(root, manager.getTranscriptPath(b).dir), b, 2);
    await manager.append(entry(a, "d1"));
    const verify = mock.method(JsonlOwnershipDigestCache.prototype, "verify");
    try {
      await manager.append(entry(b, "d2"));
      assert.equal(verify.mock.callCount(), 2, "a's memo must not skip b's first verification");
    } finally {
      verify.mock.restore();
    }
  });
});

test("a file edited behind the process is noticed only after the remembered directory is dropped", async () => {
  await withManager(async ({ manager, root }) => {
    const owner = "pi-geek:memo-edit-a";
    const intruder = "pi-geek:memo-edit-b";
    const { dir, alternateDir, file } = manager.getTranscriptPath(owner);
    await manager.append(entry(owner, "e1"));
    const primary = path.join(root, dir, file);
    await writeFile(primary, (await readFile(primary, "utf-8")).replaceAll(owner, intruder), "utf-8");

    await manager.append(entry(owner, "e2"));
    assert.ok((await jsonlContents(path.join(root, dir))).includes('"turnId":"e2"'), "the remembered directory is trusted");

    manager.resetWriteDirs();
    await manager.append(entry(owner, "e3"));
    assert.equal((await jsonlContents(path.join(root, dir))).includes('"turnId":"e3"'), false);
    assert.ok((await jsonlContents(path.join(root, alternateDir))).includes('"turnId":"e3"'));
  });
});

test("a cleanup that deletes files drops the remembered directories", async () => {
  await withManager(async ({ manager, root }) => {
    const owner = "pi-geek:memo-cleanup";
    const channelDir = path.join(root, manager.getTranscriptPath(owner).dir);
    await writeOldDays(channelDir, owner, 2); // 2026-01-01 and 2026-01-02, past any retention window
    await manager.append(entry(owner, "f1"));
    assert.equal(await manager.cleanup(30), 2);
    const verify = mock.method(JsonlOwnershipDigestCache.prototype, "verify");
    try {
      await manager.append(entry(owner, "f2"));
      assert.ok(verify.mock.callCount() >= 1, "the directory was not verified again after the cleanup");
    } finally {
      verify.mock.restore();
    }
  });
});

test("a choice that was pending when the memo was cleared or forgotten is not remembered", async () => {
  for (const invalidate of ["clear", "forget"] as const) {
    const memo = new WriteDirMemo();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const choose = async () => {
      calls++;
      if (calls === 1) await gate;
      return { dir: `d${calls}`, channelDir: `c${calls}` };
    };
    const pending = memo.resolve("root", "session", choose);
    if (invalidate === "clear") memo.clear();
    else memo.forget("root", "session");
    release();
    assert.deepEqual(await pending, { dir: "d1", channelDir: "c1" });
    assert.deepEqual(await memo.resolve("root", "session", choose), { dir: "d2", channelDir: "c2" }, `${invalidate}: stale choice was remembered`);
    assert.equal(calls, 2);
  }
});

test("the memo is a bounded LRU", async () => {
  const memo = new WriteDirMemo(2);
  const chooser = (name: string) => async () => ({ dir: name, channelDir: name });
  await memo.resolve("r", "a", chooser("a1"));
  await memo.resolve("r", "b", chooser("b1"));
  await memo.resolve("r", "a", chooser("unused")); // touch a so b is the oldest
  await memo.resolve("r", "c", chooser("c1")); // evicts b
  assert.equal((await memo.resolve("r", "a", chooser("a2"))).dir, "a1");
  assert.equal((await memo.resolve("r", "b", chooser("b2"))).dir, "b2");
  assert.throws(() => new WriteDirMemo(0), RangeError);
});
