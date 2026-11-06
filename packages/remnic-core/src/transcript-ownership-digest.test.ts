import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { parseConfig } from "./config.js";
import { JsonlOwnershipDigestCache } from "./transcript-ownership-digest.js";
import { TranscriptManager } from "./transcript.js";
import type { TranscriptEntry } from "./types.js";

function makeConfig(memoryDir: string) {
  return parseConfig({ memoryDir });
}

async function withManager(
  fn: (ctx: { manager: TranscriptManager; memoryDir: string; root: string }) => Promise<void>,
): Promise<void> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-transcript-digest-"));
  try {
    const manager = new TranscriptManager(makeConfig(memoryDir));
    await manager.initialize();
    await fn({ manager, memoryDir, root: path.join(memoryDir, "transcripts") });
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
}

function entry(sessionKey: string, turnId: string): TranscriptEntry {
  return {
    timestamp: new Date().toISOString(),
    role: "user",
    content: `turn ${turnId}`,
    sessionKey,
    turnId,
  };
}

async function jsonlContents(dir: string): Promise<string> {
  const names = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith(".jsonl")).sort();
  const parts = await Promise.all(names.map((n) => readFile(path.join(dir, n), "utf-8")));
  return parts.join("");
}

/** Overwrite a file in place with the same byte length and the same mtime. */
async function rewriteSameSize(filePath: string, transform: (text: string) => string): Promise<void> {
  const before = await stat(filePath);
  const original = await readFile(filePath, "utf-8");
  const rewritten = transform(original);
  assert.equal(Buffer.byteLength(rewritten), Buffer.byteLength(original), "test must keep byte length");
  assert.notEqual(rewritten, original);
  await writeFile(filePath, rewritten, "utf-8");
  await utimes(filePath, before.atime, before.mtime);
  assert.equal((await stat(filePath)).size, before.size);
}

test("same-size foreign rewrite with restored mtime is never served a cached owner verdict", async () => {
  await withManager(async ({ manager, root }) => {
    const owner = "pi-geek:digest-same-a";
    const intruder = "pi-geek:digest-same-b";
    assert.equal(owner.length, intruder.length);
    const { dir, alternateDir, file } = manager.getTranscriptPath(owner);
    await manager.append(entry(owner, "1"));
    await manager.append(entry(owner, "2"));
    const primary = path.join(root, dir, file);
    await rewriteSameSize(primary, (text) => text.replaceAll(owner, intruder));

    await manager.append(entry(owner, "3"));

    const primaryText = await jsonlContents(path.join(root, dir));
    assert.equal(primaryText.includes('"turnId":"3"'), false, "owner turn must not join foreign-content directory");
    assert.equal(primaryText.includes(owner), false);
    const alternateText = await jsonlContents(path.join(root, alternateDir));
    assert.equal(alternateText.includes('"turnId":"3"'), true);
  });
});

test("same-size malformed rewrite with restored mtime is never served a cached owner verdict", async () => {
  await withManager(async ({ manager, root }) => {
    const owner = "pi-geek:digest-malformed";
    const { dir, alternateDir, file } = manager.getTranscriptPath(owner);
    await manager.append(entry(owner, "1"));
    await manager.append(entry(owner, "2"));
    const primary = path.join(root, dir, file);
    await rewriteSameSize(primary, (text) => text.replace('{"timestamp"', '{"timestamp:'));

    await manager.append(entry(owner, "3"));

    assert.equal((await jsonlContents(path.join(root, dir))).includes('"turnId":"3"'), false);
    assert.equal((await jsonlContents(path.join(root, alternateDir))).includes('"turnId":"3"'), true);
  });
});

test("a read error after a cached owner verdict makes the directory occupied", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root bypasses file permissions");
    return;
  }
  await withManager(async ({ manager, root }) => {
    const owner = "pi-geek:digest-readerr";
    const { dir, alternateDir, file } = manager.getTranscriptPath(owner);
    await manager.append(entry(owner, "1"));
    await manager.append(entry(owner, "2"));
    const primary = path.join(root, dir, file);
    await chmod(primary, 0o000);
    try {
      await manager.append(entry(owner, "3"));
    } finally {
      await chmod(primary, 0o600);
    }

    assert.equal((await jsonlContents(path.join(root, dir))).includes('"turnId":"3"'), false);
    assert.equal((await jsonlContents(path.join(root, alternateDir))).includes('"turnId":"3"'), true);
  });
});

test("editing a cached prefix while the file grows is detected by content, not size", async () => {
  await withManager(async ({ manager, root }) => {
    const owner = "pi-geek:digest-prefix-a";
    const intruder = "pi-geek:digest-prefix-b";
    const { dir, alternateDir, file } = manager.getTranscriptPath(owner);
    for (const id of ["1", "2", "3"]) await manager.append(entry(owner, id));
    const primary = path.join(root, dir, file);
    const text = await readFile(primary, "utf-8");
    const [first, ...rest] = text.split("\n");
    await writeFile(primary, [first.replace(owner, intruder), ...rest].join("\n"), "utf-8");
    const grown = (await readFile(primary, "utf-8")) + JSON.stringify(entry(owner, "x")) + "\n";
    await writeFile(primary, grown, "utf-8");

    await manager.append(entry(owner, "4"));

    assert.equal((await jsonlContents(path.join(root, dir))).includes('"turnId":"4"'), false);
    assert.equal((await jsonlContents(path.join(root, alternateDir))).includes('"turnId":"4"'), true);
  });
});

test("an owner's cached verdict is never shared with another session on the same directory", async () => {
  await withManager(async ({ manager, root }) => {
    const a = "agent:alpha:discord:channel:777";
    const b = "agent:beta:discord:channel:777";
    const pa = manager.getTranscriptPath(a);
    const pb = manager.getTranscriptPath(b);
    assert.equal(pa.dir, pb.dir, "legacy keys must share a channel directory for this test");
    await manager.append(entry(a, "1"));
    await manager.append(entry(a, "2"));

    await manager.append(entry(b, "1"));

    const shared = await jsonlContents(path.join(root, pa.dir));
    assert.equal(shared.includes(b), false, "foreign session must not write into the owner's directory");
    assert.equal((await jsonlContents(path.join(root, pb.alternateDir))).includes(b), true);
  });
});

test("steady-state appends parse only new lines, not the accumulated history", async () => {
  await withManager(async ({ manager, root }) => {
    const owner = "pi-geek:digest-steady";
    const { dir } = manager.getTranscriptPath(owner);
    const channelDir = path.join(root, dir);
    await mkdir(channelDir, { recursive: true });
    const linesPerDay = 100;
    for (let day = 1; day <= 20; day++) {
      const date = new Date(Date.UTC(2026, 8, day)).toISOString().slice(0, 10);
      const lines = Array.from({ length: linesPerDay }, (_, i) =>
        JSON.stringify({ ...entry(owner, `h${day}-${i}`), timestamp: `${date}T12:00:00.000Z` }),
      );
      await writeFile(path.join(channelDir, `${date}.jsonl`), lines.join("\n") + "\n", "utf-8");
    }

    const parseSpy = mock.method(JSON, "parse");
    try {
      await manager.append(entry(owner, "a1"));
      assert.ok(parseSpy.mock.callCount() >= 20 * linesPerDay, "first append must verify the full history");
      for (const id of ["a2", "a3", "a4"]) {
        parseSpy.mock.resetCalls();
        await manager.append(entry(owner, id));
        const parses = parseSpy.mock.callCount();
        assert.ok(parses <= 2, `append ${id} re-parsed ${parses} lines`);
      }
    } finally {
      parseSpy.mock.restore();
    }
  });
});

test("digest cache: bounded size, exact verdicts across eviction", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-digest-cache-"));
  try {
    const key = "pi-geek:cache-bound";
    const line = JSON.stringify({ sessionKey: key, content: "x" }) + "\n";
    const cache = new JsonlOwnershipDigestCache(2);
    const files = ["a", "b", "c"].map((n) => path.join(dir, `${n}.jsonl`));
    for (const f of files) await writeFile(f, line, "utf-8");
    for (const f of files) assert.equal(await cache.verify(f, key), "matches");
    assert.ok(cache.size <= 2, `cache grew to ${cache.size}`);
    for (const f of files) assert.equal(await cache.verify(f, key), "matches");
    assert.ok(cache.size <= 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("digest cache: verdicts are keyed by session and re-derived from bytes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-digest-cache-"));
  try {
    const cache = new JsonlOwnershipDigestCache();
    const file = path.join(dir, "d.jsonl");
    const mine = "pi-geek:cache-mine";
    const other = "pi-geek:cache-othr";
    await writeFile(file, JSON.stringify({ sessionKey: mine }) + "\n", "utf-8");
    assert.equal(await cache.verify(file, mine), "matches");
    assert.equal(await cache.verify(file, other), "foreign");
    assert.equal(await cache.verify(file, mine), "matches");

    await writeFile(file, "\n  \n", "utf-8");
    assert.equal(await cache.verify(file, mine), "empty");

    await writeFile(file, "null\n", "utf-8");
    assert.equal(await cache.verify(file, mine), "foreign", "JSON null has no owner");
    await writeFile(file, "42\n", "utf-8");
    assert.equal(await cache.verify(file, mine), "foreign");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("digest cache: unterminated trailing line is judged but never cached as complete", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-digest-cache-"));
  try {
    const cache = new JsonlOwnershipDigestCache();
    const file = path.join(dir, "p.jsonl");
    const key = "pi-geek:cache-partial";
    const good = JSON.stringify({ sessionKey: key, n: 1 });
    await writeFile(file, `${good}\n${good.slice(0, -4)}`, "utf-8");
    assert.equal(await cache.verify(file, key), "foreign", "torn trailing line is malformed");

    await writeFile(file, `${good}\n${good}`, "utf-8");
    assert.equal(await cache.verify(file, key), "matches", "valid unterminated last line counts");

    await writeFile(file, `${good}\n${good}\n`, "utf-8");
    assert.equal(await cache.verify(file, key), "matches");

    await writeFile(file, `${good}\n`, "utf-8");
    assert.equal(await cache.verify(file, key), "matches", "truncation re-derives from bytes");

    await writeFile(file, `${good.replace(key, "pi-geek:cache-other")}\n`, "utf-8");
    assert.equal(await cache.verify(file, key), "foreign", "same-length foreign replacement");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("digest cache: read errors surface to the caller instead of a cached verdict", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-digest-cache-"));
  try {
    const cache = new JsonlOwnershipDigestCache();
    const file = path.join(dir, "gone.jsonl");
    const key = "pi-geek:cache-gone";
    await writeFile(file, JSON.stringify({ sessionKey: key }) + "\n", "utf-8");
    assert.equal(await cache.verify(file, key), "matches");
    await rm(file);
    await assert.rejects(cache.verify(file, key));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
