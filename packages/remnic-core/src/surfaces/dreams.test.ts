import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDreamsSurface } from "./dreams.js";

test("dreams surface reads OpenClaw dream diary blocks from DREAMS.md", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-dreams-surface-"));
  const dreamsPath = path.join(root, "DREAMS.md");
  await writeFile(
    dreamsPath,
    [
      "# Dream Diary",
      "",
      "<!-- openclaw:dreaming:diary:start -->",
      "---",
      "",
      "*April 5, 2026, 10:00 AM*",
      "",
      "The build lights felt warm today.",
      "",
      "---",
      "",
      "*April 6, 2026, 11:45 AM*",
      "",
      "A second entry with unicode: cafe, naive, and snowman ☃.",
      "",
      "<!-- openclaw:dreaming:diary:end -->",
      "",
    ].join("\n"),
    "utf8",
  );

  const surface = createDreamsSurface();
  const entries = await surface.read(dreamsPath);

  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.title, null);
  assert.match(entries[0]?.timestamp ?? "", /^April 5, 2026/);
  assert.match(entries[0]?.body ?? "", /build lights felt warm/);
  assert.match(entries[1]?.body ?? "", /snowman ☃/);
  assert.ok(entries[1]?.sourceOffset > entries[0]!.sourceOffset);
});

test("dreams surface reads legacy heading entries with title and tags", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-dreams-legacy-"));
  const dreamsPath = path.join(root, "dreams.md");
  await writeFile(
    dreamsPath,
    [
      "# Dreams",
      "",
      "## 2026-04-11T03:22:14Z — Patterns in today's debugging",
      "",
      "I kept seeing the same flaky test from three angles.",
      "",
      "Tags: #debug #recurring #frustration",
      "",
      "---",
      "",
      "## 2026-04-11T01:05:02Z",
      "",
      "Untitled entry body with no trailing newline.",
    ].join("\n"),
    "utf8",
  );

  const surface = createDreamsSurface();
  const entries = await surface.read(dreamsPath);

  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.title, "Patterns in today's debugging");
  assert.equal(entries[0]?.timestamp, "2026-04-11T03:22:14Z");
  assert.deepEqual(entries[0]?.tags, ["debug", "recurring", "frustration"]);
  assert.equal(entries[1]?.title, null);
  assert.match(entries[1]?.body ?? "", /Untitled entry body/);
});

test("dreams surface append migrates legacy heading entries into the diary markers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-dreams-legacy-migrate-"));
  const dreamsPath = path.join(root, "dreams.md");
  await writeFile(
    dreamsPath,
    [
      "# Dreams",
      "",
      "## 2026-04-11T03:22:14Z — Patterns in today's debugging",
      "",
      "I kept seeing the same flaky test from three angles.",
      "",
      "Tags: #debug #recurring #frustration",
      "",
      "---",
      "",
      "## 2026-04-11T01:05:02Z",
      "",
      "Untitled entry body with no trailing newline.",
    ].join("\n"),
    "utf8",
  );

  const surface = createDreamsSurface();
  await surface.append(dreamsPath, {
    timestamp: "2026-04-12T15:00:00Z",
    title: "A useful reflective note",
    body: "Today the adapter stopped pretending and started verifying.",
    tags: ["reflection", "verification"],
  });

  const content = await readFile(dreamsPath, "utf8");
  assert.match(content, /openclaw:dreaming:diary:start/);
  assert.match(content, /Patterns in today's debugging/);
  assert.match(content, /A useful reflective note/);

  const reread = await surface.read(dreamsPath);
  assert.equal(reread.length, 3);
  assert.equal(reread[0]?.title, "Patterns in today's debugging");
  assert.equal(reread[2]?.title, "A useful reflective note");
});

test("dreams surface preserves legacy in-body dividers through append migration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-dreams-legacy-body-divider-"));
  const dreamsPath = path.join(root, "dreams.md");
  await writeFile(
    dreamsPath,
    [
      "# Dreams",
      "",
      "## 2026-04-11T03:22:14Z",
      "",
      "first",
      "",
      "---",
      "",
      "second",
    ].join("\n"),
    "utf8",
  );

  const surface = createDreamsSurface();
  const entries = await surface.read(dreamsPath);

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.body, ["first", "", "---", "", "second"].join("\n"));

  await surface.append(dreamsPath, {
    timestamp: "2026-04-12T15:00:00Z",
    title: "Migrating without loss",
    body: "new entry",
    tags: [],
  });

  const migrated = await surface.read(dreamsPath);
  assert.equal(migrated.length, 2);
  assert.equal(migrated[0]?.body, ["first", "", "---", "", "second"].join("\n"));
});

test("dreams surface appends a new OpenClaw diary entry and round-trips cleanly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-dreams-append-"));
  const dreamsPath = path.join(root, "DREAMS.md");
  const surface = createDreamsSurface();

  const appended = await surface.append(dreamsPath, {
    timestamp: "2026-04-12T15:00:00Z",
    title: "A useful reflective note",
    body: "Today the adapter stopped pretending and started verifying.",
    tags: ["reflection", "verification"],
  });

  assert.equal(appended.title, "A useful reflective note");

  const content = await readFile(dreamsPath, "utf8");
  assert.match(content, /# Dream Diary/);
  assert.match(content, /openclaw:dreaming:diary:start/);
  assert.match(content, /\*2026-04-12T15:00:00Z — A useful reflective note\*/);

  const reread = await surface.read(dreamsPath);
  assert.equal(reread.length, 1);
  assert.equal(reread[0]?.id, appended.id);
  assert.deepEqual(reread[0]?.tags, ["reflection", "verification"]);
});

test("dreams surface serializes concurrent appends to preserve every entry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-dreams-concurrent-"));
  const dreamsPath = path.join(root, "DREAMS.md");
  const surface = createDreamsSurface();

  await surface.append(dreamsPath, {
    timestamp: "2026-04-12T15:00:00Z",
    title: "Seed",
    body: "existing entry",
    tags: [],
  });

  await Promise.all([
    surface.append(dreamsPath, {
      timestamp: "2026-04-12T16:00:00Z",
      title: "Concurrent A",
      body: "first concurrent entry",
      tags: [],
    }),
    surface.append(dreamsPath, {
      timestamp: "2026-04-12T17:00:00Z",
      title: "Concurrent B",
      body: "second concurrent entry",
      tags: [],
    }),
  ]);

  const reread = await surface.read(dreamsPath);
  assert.equal(reread.length, 3);
  assert.deepEqual(reread.map((entry) => entry.title).sort(), [
    "Concurrent A",
    "Concurrent B",
    "Seed",
  ]);
});

test("dream surface keeps entry ids stable when title, body, or tags are edited in place", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-dreams-stable-id-"));
  const dreamsPath = path.join(root, "DREAMS.md");
  const surface = createDreamsSurface();

  await writeFile(
    dreamsPath,
    [
      "# Dream Diary",
      "",
      "<!-- openclaw:dreaming:diary:start -->",
      "---",
      "",
      "*2026-04-12T15:00:00Z — First draft title*",
      "",
      "Initial body text.",
      "",
      "Tags: #reflection",
      "",
      "<!-- openclaw:dreaming:diary:end -->",
      "",
    ].join("\n"),
    "utf8",
  );

  const firstRead = await surface.read(dreamsPath);
  const originalId = firstRead[0]?.id;
  assert.ok(originalId);

  await writeFile(
    dreamsPath,
    [
      "# Dream Diary",
      "",
      "<!-- openclaw:dreaming:diary:start -->",
      "---",
      "",
      "*2026-04-12T15:00:00Z — Refined title*",
      "",
      "Updated body text with more detail.",
      "",
      "Tags: #reflection #verification",
      "",
      "<!-- openclaw:dreaming:diary:end -->",
      "",
    ].join("\n"),
    "utf8",
  );

  const secondRead = await surface.read(dreamsPath);
  assert.equal(secondRead[0]?.id, originalId);
  assert.equal(secondRead[0]?.title, "Refined title");
  assert.deepEqual(secondRead[0]?.tags, ["reflection", "verification"]);
});

test("dreams surface preserves body dividers inside a single diary entry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-dreams-body-divider-"));
  const dreamsPath = path.join(root, "DREAMS.md");
  await writeFile(
    dreamsPath,
    [
      "# Dream Diary",
      "",
      "<!-- openclaw:dreaming:diary:start -->",
      "---",
      "",
      "*2026-04-12T15:00:00Z — Divider dream*",
      "",
      "The reflection starts normally.",
      "",
      "---",
      "",
      "The divider is part of the body, not a new entry.",
      "",
      "Tags: #reflection",
      "",
      "<!-- openclaw:dreaming:diary:end -->",
      "",
    ].join("\n"),
    "utf8",
  );

  const surface = createDreamsSurface();
  const entries = await surface.read(dreamsPath);

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.title, "Divider dream");
  assert.equal(
    entries[0]?.body,
    [
      "The reflection starts normally.",
      "",
      "---",
      "",
      "The divider is part of the body, not a new entry.",
    ].join("\n"),
  );
});

test("dreams surface watch reacts when DREAMS.md is created after startup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-dreams-watch-create-"));
  const dreamsPath = path.join(root, "DREAMS.md");
  const surface = createDreamsSurface();

  const entriesPromise = new Promise<Awaited<ReturnType<typeof surface.read>>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      stop();
      reject(new Error("dream watcher did not fire after file creation"));
    }, 2000);
    const stop = surface.watch(dreamsPath, (entries) => {
      clearTimeout(timeout);
      stop();
      resolve(entries);
    });
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  await writeFile(
    dreamsPath,
    [
      "# Dream Diary",
      "",
      "<!-- openclaw:dreaming:diary:start -->",
      "---",
      "",
      "*2026-04-12T15:00:00Z — Fresh start*",
      "",
      "The file appeared after startup.",
      "",
      "<!-- openclaw:dreaming:diary:end -->",
      "",
    ].join("\n"),
    "utf8",
  );

  const entries = await entriesPromise;
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.title, "Fresh start");
});

test("dreams surface watch recovers when the dream journal directory appears after startup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-dreams-watch-missing-dir-"));
  const nestedDir = path.join(root, "missing");
  const dreamsPath = path.join(nestedDir, "DREAMS.md");
  const surface = createDreamsSurface();

  const entriesPromise = new Promise<Awaited<ReturnType<typeof surface.read>>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      stop();
      reject(new Error("dream watcher did not recover after directory creation"));
    }, 2000);
    const stop = surface.watch(dreamsPath, (entries) => {
      clearTimeout(timeout);
      stop();
      resolve(entries);
    });
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  await mkdir(nestedDir, { recursive: true });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await writeFile(
    dreamsPath,
    [
      "# Dream Diary",
      "",
      "<!-- openclaw:dreaming:diary:start -->",
      "---",
      "",
      "*2026-04-12T17:00:00Z — Recovered watcher*",
      "",
      "The watcher survived a missing parent directory.",
      "",
      "<!-- openclaw:dreaming:diary:end -->",
      "",
    ].join("\n"),
    "utf8",
  );

  const entries = await entriesPromise;
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.title, "Recovered watcher");
});

test("dreams surface watch catches callback failures instead of leaking unhandled rejections", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-dreams-watch-errors-"));
  const dreamsPath = path.join(root, "DREAMS.md");
  const surface = createDreamsSurface();
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  await writeFile(
    dreamsPath,
    [
      "# Dream Diary",
      "",
      "<!-- openclaw:dreaming:diary:start -->",
      "---",
      "",
      "*2026-04-12T14:00:00Z — Initial entry*",
      "",
      "Create the watched file before arming the watcher.",
      "",
      "<!-- openclaw:dreaming:diary:end -->",
      "",
    ].join("\n"),
    "utf8",
  );
  const stop = surface.watch(dreamsPath, () => {
    throw new Error("boom");
  });

  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await writeFile(
      dreamsPath,
      [
        "# Dream Diary",
        "",
        "<!-- openclaw:dreaming:diary:start -->",
        "---",
        "",
        "*2026-04-12T15:00:00Z — Fresh start*",
        "",
        "Trigger the callback error path.",
        "",
        "<!-- openclaw:dreaming:diary:end -->",
        "",
      ].join("\n"),
      "utf8",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    console.warn = originalWarn;
    stop();
  }

  assert.equal(warnings.length >= 1, true);
  assert.equal(
    warnings.some((args) =>
      /dreams surface watch update failed/.test(String(args[0] ?? ""))),
    true,
  );
});
