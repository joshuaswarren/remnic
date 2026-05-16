import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ThreadingManager } from "../src/threading.js";

async function makeTmp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "engram-threading-"));
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

test("appendEpisodeIds appends IDs to existing thread", async () => {
  const dir = await makeTmp();
  try {
    const tm = new ThreadingManager(path.join(dir, "threads"), 30);
    const turn = {
      role: "user" as const,
      content: "hello",
      timestamp: "2026-02-22T15:00:00.000Z",
      sessionKey: "s1",
    };

    const threadId = await tm.processTurn(turn, []);
    await tm.appendEpisodeIds(threadId, ["fact-1", "fact-2"]);

    const thread = await tm.loadThread(threadId);
    assert.ok(thread);
    assert.deepEqual(thread!.episodeIds, ["fact-1", "fact-2"]);
  } finally {
    await cleanup(dir);
  }
});

test("appendEpisodeIds de-duplicates existing IDs", async () => {
  const dir = await makeTmp();
  try {
    const tm = new ThreadingManager(path.join(dir, "threads"), 30);
    const turn = {
      role: "user" as const,
      content: "hello",
      timestamp: "2026-02-22T15:00:00.000Z",
      sessionKey: "s1",
    };

    const threadId = await tm.processTurn(turn, ["fact-1"]);
    await tm.appendEpisodeIds(threadId, ["fact-1", "fact-2"]);

    const thread = await tm.loadThread(threadId);
    assert.ok(thread);
    assert.deepEqual(thread!.episodeIds, ["fact-1", "fact-2"]);
  } finally {
    await cleanup(dir);
  }
});

test("thread IDs are encoded before reading and writing thread files", async () => {
  const dir = await makeTmp();
  try {
    const threadsDir = path.join(dir, "threads");
    const outsideDir = path.join(dir, "escape");
    const outsidePath = path.join(outsideDir, "thread.json");
    const outsideContent = JSON.stringify({ id: "outside" });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(outsidePath, outsideContent, "utf-8");

    const tm = new ThreadingManager(threadsDir, 30);
    const unsafeThreadId = "../escape/thread";
    await tm.saveThread({
      id: unsafeThreadId,
      title: "Unsafe Thread ID",
      createdAt: "2026-02-22T15:00:00.000Z",
      updatedAt: "2026-02-22T15:00:00.000Z",
      sessionKey: "s1",
      episodeIds: ["fact-1"],
      linkedThreadIds: [],
    });

    assert.equal(await readFile(outsidePath, "utf-8"), outsideContent);

    const loaded = await tm.loadThread(unsafeThreadId);
    assert.equal(loaded?.id, unsafeThreadId);
    assert.deepEqual(loaded?.episodeIds, ["fact-1"]);

    const threadFiles = await readdir(threadsDir);
    assert.ok(
      threadFiles.includes("%2E%2E%2Fescape%2Fthread.json"),
      "unsafe thread ID should be encoded as one filename segment",
    );

    const allThreads = await tm.getAllThreads();
    assert.ok(allThreads.some((thread) => thread.id === unsafeThreadId));
  } finally {
    await cleanup(dir);
  }
});

test("legacy safe thread filenames remain loadable and writable", async () => {
  const dir = await makeTmp();
  try {
    const threadsDir = path.join(dir, "threads");
    await mkdir(threadsDir, { recursive: true });
    await writeFile(
      path.join(threadsDir, "release.v1.json"),
      JSON.stringify({
        id: "release.v1",
        title: "Release V1",
        createdAt: "2026-02-22T15:00:00.000Z",
        updatedAt: "2026-02-22T15:00:00.000Z",
        sessionKey: "s1",
        episodeIds: ["fact-1"],
        linkedThreadIds: [],
      }),
      "utf-8",
    );

    const tm = new ThreadingManager(threadsDir, 30);
    const loaded = await tm.loadThread("release.v1");
    assert.equal(loaded?.title, "Release V1");

    await tm.appendEpisodeIds("release.v1", ["fact-2"]);
    const legacyRaw = await readFile(path.join(threadsDir, "release.v1.json"), "utf-8");
    assert.match(legacyRaw, /fact-2/);
    await assert.rejects(
      readFile(path.join(threadsDir, "release%2Ev1.json"), "utf-8"),
      { code: "ENOENT" },
    );
  } finally {
    await cleanup(dir);
  }
});

test("thread writes keep using encoded file when encoded and legacy files both exist", async () => {
  const dir = await makeTmp();
  try {
    const threadsDir = path.join(dir, "threads");
    await mkdir(threadsDir, { recursive: true });
    await writeFile(
      path.join(threadsDir, "release.v1.json"),
      JSON.stringify({
        id: "release.v1",
        title: "Legacy Release V1",
        createdAt: "2026-02-22T15:00:00.000Z",
        updatedAt: "2026-02-22T15:00:00.000Z",
        sessionKey: "s1",
        episodeIds: ["legacy-fact"],
        linkedThreadIds: [],
      }),
      "utf-8",
    );
    await writeFile(
      path.join(threadsDir, "release%2Ev1.json"),
      JSON.stringify({
        id: "release.v1",
        title: "Encoded Release V1",
        createdAt: "2026-02-22T15:00:00.000Z",
        updatedAt: "2026-02-23T15:00:00.000Z",
        sessionKey: "s1",
        episodeIds: ["encoded-fact"],
        linkedThreadIds: [],
      }),
      "utf-8",
    );

    const tm = new ThreadingManager(threadsDir, 30);
    const loaded = await tm.loadThread("release.v1");
    assert.equal(loaded?.title, "Encoded Release V1");

    await tm.appendEpisodeIds("release.v1", ["new-fact"]);
    const encodedRaw = await readFile(path.join(threadsDir, "release%2Ev1.json"), "utf-8");
    const legacyRaw = await readFile(path.join(threadsDir, "release.v1.json"), "utf-8");
    assert.match(encodedRaw, /new-fact/);
    assert.doesNotMatch(legacyRaw, /new-fact/);
  } finally {
    await cleanup(dir);
  }
});

test("getAllThreads de-duplicates legacy and encoded copies by thread ID", async () => {
  const dir = await makeTmp();
  try {
    const threadsDir = path.join(dir, "threads");
    await mkdir(threadsDir, { recursive: true });
    await writeFile(
      path.join(threadsDir, "release.v1.json"),
      JSON.stringify({
        id: "release.v1",
        title: "Legacy Release V1",
        createdAt: "2026-02-22T15:00:00.000Z",
        updatedAt: "2026-02-23T15:00:00.000Z",
        sessionKey: "s1",
        episodeIds: ["legacy-fact"],
        linkedThreadIds: [],
      }),
      "utf-8",
    );
    await writeFile(
      path.join(threadsDir, "release%2Ev1.json"),
      JSON.stringify({
        id: "release.v1",
        title: "Encoded Release V1",
        createdAt: "2026-02-22T15:00:00.000Z",
        updatedAt: "2026-02-22T15:00:00.000Z",
        sessionKey: "s1",
        episodeIds: ["encoded-fact"],
        linkedThreadIds: [],
      }),
      "utf-8",
    );

    const tm = new ThreadingManager(threadsDir, 30);
    const threads = await tm.getAllThreads();

    assert.deepEqual(threads.map((thread) => thread.id), ["release.v1"]);
    assert.equal(threads[0]?.title, "Encoded Release V1");
  } finally {
    await cleanup(dir);
  }
});

test("legacy thread fallback does not reuse a colliding encoded filename", async () => {
  const dir = await makeTmp();
  try {
    const threadsDir = path.join(dir, "threads");
    await mkdir(threadsDir, { recursive: true });
    await writeFile(
      path.join(threadsDir, "release%2Ev1.json"),
      JSON.stringify({
        id: "release.v1",
        title: "Release V1",
        createdAt: "2026-02-22T15:00:00.000Z",
        updatedAt: "2026-02-22T15:00:00.000Z",
        sessionKey: "s1",
        episodeIds: ["fact-1"],
        linkedThreadIds: [],
      }),
      "utf-8",
    );

    const tm = new ThreadingManager(threadsDir, 30);
    assert.equal(await tm.loadThread("release%2Ev1"), null);

    await tm.saveThread({
      id: "release%2Ev1",
      title: "Encoded Percent Thread",
      createdAt: "2026-02-22T15:00:00.000Z",
      updatedAt: "2026-02-22T15:00:00.000Z",
      sessionKey: "s1",
      episodeIds: ["fact-2"],
      linkedThreadIds: [],
    });

    const originalRaw = await readFile(path.join(threadsDir, "release%2Ev1.json"), "utf-8");
    const encodedRaw = await readFile(path.join(threadsDir, "release%252Ev1.json"), "utf-8");
    assert.match(originalRaw, /"id":"release\.v1"/);
    assert.match(encodedRaw, /"id": "release%2Ev1"/);
    assert.equal((await tm.loadThread("release%2Ev1"))?.title, "Encoded Percent Thread");
  } finally {
    await cleanup(dir);
  }
});

test("thread writes fall back to encoded file when legacy file is malformed", async () => {
  const dir = await makeTmp();
  try {
    const threadsDir = path.join(dir, "threads");
    await mkdir(threadsDir, { recursive: true });
    await writeFile(path.join(threadsDir, "release.v1.json"), "{not json", "utf-8");

    const tm = new ThreadingManager(threadsDir, 30);
    await tm.saveThread({
      id: "release.v1",
      title: "Release V1",
      createdAt: "2026-02-22T15:00:00.000Z",
      updatedAt: "2026-02-22T15:00:00.000Z",
      sessionKey: "s1",
      episodeIds: ["fact-1"],
      linkedThreadIds: [],
    });

    assert.equal(await readFile(path.join(threadsDir, "release.v1.json"), "utf-8"), "{not json");
    const encodedRaw = await readFile(path.join(threadsDir, "release%2Ev1.json"), "utf-8");
    assert.match(encodedRaw, /"id": "release\.v1"/);
  } finally {
    await cleanup(dir);
  }
});

test("thread writes do not overwrite encoded paths occupied by another thread ID", async () => {
  const dir = await makeTmp();
  try {
    const threadsDir = path.join(dir, "threads");
    await mkdir(threadsDir, { recursive: true });
    await writeFile(
      path.join(threadsDir, "release%2Ev1.json"),
      JSON.stringify({
        id: "release%2Ev1",
        title: "Legacy Percent Thread",
        createdAt: "2026-02-22T15:00:00.000Z",
        updatedAt: "2026-02-22T15:00:00.000Z",
        sessionKey: "s1",
        episodeIds: ["legacy-fact"],
        linkedThreadIds: [],
      }),
      "utf-8",
    );

    const tm = new ThreadingManager(threadsDir, 30);
    await tm.saveThread({
      id: "release.v1",
      title: "Release V1",
      createdAt: "2026-02-22T15:00:00.000Z",
      updatedAt: "2026-02-22T15:00:00.000Z",
      sessionKey: "s2",
      episodeIds: ["new-fact"],
      linkedThreadIds: [],
    });

    const originalRaw = await readFile(path.join(threadsDir, "release%2Ev1.json"), "utf-8");
    assert.match(originalRaw, /"id":"release%2Ev1"/);
    assert.match(originalRaw, /legacy-fact/);
    assert.equal((await tm.loadThread("release.v1"))?.title, "Release V1");
    assert.equal((await tm.loadThread("release%2Ev1"))?.title, "Legacy Percent Thread");
  } finally {
    await cleanup(dir);
  }
});

test("getAllThreads skips null thread files without dropping valid threads", async () => {
  const dir = await makeTmp();
  try {
    const threadsDir = path.join(dir, "threads");
    await mkdir(threadsDir, { recursive: true });
    await writeFile(path.join(threadsDir, "bad.json"), "null", "utf-8");
    await writeFile(
      path.join(threadsDir, "good.json"),
      JSON.stringify({
        id: "good",
        title: "Good Thread",
        createdAt: "2026-02-22T15:00:00.000Z",
        updatedAt: "2026-02-22T15:00:00.000Z",
        sessionKey: "s1",
        episodeIds: ["fact-1"],
        linkedThreadIds: [],
      }),
      "utf-8",
    );

    const tm = new ThreadingManager(threadsDir, 30);
    const threads = await tm.getAllThreads();

    assert.equal(threads.length, 1);
    assert.equal(threads[0]?.id, "good");
  } finally {
    await cleanup(dir);
  }
});

test("thread writes reject symlinked thread roots", async (t) => {
  if (process.platform === "win32") {
    t.skip("directory symlink setup is platform-specific");
    return;
  }

  const dir = await makeTmp();
  const outsideDir = await makeTmp();
  try {
    const threadsDir = path.join(dir, "threads");
    await symlink(outsideDir, threadsDir, "dir");

    const tm = new ThreadingManager(threadsDir, 30);
    await assert.rejects(
      tm.saveThread({
        id: "thread-1",
        title: "Thread",
        createdAt: "2026-02-22T15:00:00.000Z",
        updatedAt: "2026-02-22T15:00:00.000Z",
        sessionKey: "s1",
        episodeIds: ["fact-1"],
        linkedThreadIds: [],
      }),
      /symlink/i,
    );
    await assert.rejects(
      readFile(path.join(outsideDir, "thread-1.json"), "utf-8"),
      { code: "ENOENT" },
    );
  } finally {
    await cleanup(dir);
    await cleanup(outsideDir);
  }
});
