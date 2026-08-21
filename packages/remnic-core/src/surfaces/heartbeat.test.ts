import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHeartbeatSurface } from "./heartbeat.js";

test("heartbeat surface reads section-based entries with schedule and tags", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-heartbeat-surface-"));
  const heartbeatPath = path.join(root, "HEARTBEAT.md");
  await writeFile(
    heartbeatPath,
    [
      "# Heartbeat Tasks",
      "",
      "## check-test-suite",
      "",
      "Every hour, run the test suite and flag any new failures.",
      "",
      "Schedule: hourly",
      "Tags: #ci #tests",
      "",
      "---",
      "",
      "## sync-secrets",
      "",
      "Every day at 09:00, refresh dev secrets from the vault.",
      "",
      "Schedule: daily 09:00",
      "Tags: #secrets #ops",
      "",
    ].join("\n"),
    "utf8",
  );

  const surface = createHeartbeatSurface();
  const entries = await surface.read(heartbeatPath);

  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.slug, "check-test-suite");
  assert.equal(entries[0]?.schedule, "hourly");
  assert.deepEqual(entries[0]?.tags, ["ci", "tests"]);
  assert.equal(entries[1]?.slug, "sync-secrets");
  assert.equal(entries[1]?.schedule, "daily 09:00");
  assert.match(entries[1]?.body ?? "", /refresh dev secrets/);
});

test("heartbeat surface preserves in-body markdown dividers while still stripping a trailing section separator", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-heartbeat-divider-body-"));
  const heartbeatPath = path.join(root, "HEARTBEAT.md");
  await writeFile(
    heartbeatPath,
    [
      "## check-test-suite",
      "",
      "Run the suite in phases:",
      "",
      "---",
      "",
      "1. Smoke.",
      "2. Full regression.",
      "",
      "Schedule: hourly",
      "",
      "---",
      "",
    ].join("\n"),
    "utf8",
  );

  const surface = createHeartbeatSurface();
  const entries = await surface.read(heartbeatPath);

  assert.equal(entries.length, 1);
  assert.match(entries[0]?.body ?? "", /Run the suite in phases:/);
  assert.match(entries[0]?.body ?? "", /\n---\n/);
  assert.doesNotMatch(entries[0]?.body ?? "", /\n---\s*$/);
});

test("heartbeat surface reads tasks blocks from upstream-style HEARTBEAT.md", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-heartbeat-tasks-"));
  const heartbeatPath = path.join(root, "HEARTBEAT.md");
  await writeFile(
    heartbeatPath,
    [
      "# Keep this file empty to skip heartbeat API calls.",
      "",
      "tasks:",
      "  - name: email-check",
      "    interval: 30m",
      "    prompt: \"Check for urgent unread emails\"",
      "  - name: test-suite",
      "    interval: 1h",
      "    prompt: \"Run the test suite and report new failures\"",
      "",
    ].join("\n"),
    "utf8",
  );

  const surface = createHeartbeatSurface();
  const entries = await surface.read(heartbeatPath);

  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.slug, "email-check");
  assert.equal(entries[0]?.schedule, "30m");
  assert.equal(entries[0]?.title, "email-check");
  assert.equal(entries[1]?.slug, "test-suite");
  assert.match(entries[1]?.body ?? "", /new failures/);
});

test("heartbeat surface reads multiline task prompts from YAML block scalars", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-heartbeat-multiline-prompt-"));
  const heartbeatPath = path.join(root, "HEARTBEAT.md");
  await writeFile(
    heartbeatPath,
    [
      "tasks:",
      "  - name: release-check",
      "    interval: 1h",
      "    prompt: |",
      "      Check release readiness across CI, changelog, and open blockers.",
      "      Summarize anything still stopping a ship call.",
      "",
    ].join("\n"),
    "utf8",
  );

  const surface = createHeartbeatSurface();
  const entries = await surface.read(heartbeatPath);

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.slug, "release-check");
  assert.equal(entries[0]?.schedule, "1h");
  assert.equal(
    entries[0]?.body,
    [
      "Check release readiness across CI, changelog, and open blockers.",
      "Summarize anything still stopping a ship call.",
    ].join("\n"),
  );
});

test("heartbeat surface tracks source offsets for repeated task lines correctly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-heartbeat-offsets-"));
  const heartbeatPath = path.join(root, "HEARTBEAT.md");
  const content = [
    "# Notes",
    "",
    "Example repeated line:",
    "  - name: email-check",
    "",
    "tasks:",
    "  - name: email-check",
    "    interval: 30m",
    "    prompt: \"Check for urgent unread emails\"",
    "",
  ].join("\n");
  await writeFile(heartbeatPath, content, "utf8");

  const surface = createHeartbeatSurface();
  const entries = await surface.read(heartbeatPath);

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.slug, "email-check");
  assert.equal(entries[0]?.sourceOffset, content.lastIndexOf("  - name: email-check"));
});

test("heartbeat surface keeps entry ids stable when body, schedule, or tags are edited in place", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-heartbeat-stable-id-"));
  const heartbeatPath = path.join(root, "HEARTBEAT.md");
  const surface = createHeartbeatSurface();

  await writeFile(
    heartbeatPath,
    [
      "## check-test-suite",
      "",
      "Run the suite and report new failures.",
      "",
      "Schedule: hourly",
      "Tags: #ci #tests",
      "",
    ].join("\n"),
    "utf8",
  );

  const first = await surface.read(heartbeatPath);

  await writeFile(
    heartbeatPath,
    [
      "## check-test-suite",
      "",
      "Run the suite, compare to the last run, and report new failures.",
      "",
      "Schedule: every 2 hours",
      "Tags: #ci #tests #diff",
      "",
    ].join("\n"),
    "utf8",
  );

  const second = await surface.read(heartbeatPath);

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(first[0]?.slug, "check-test-suite");
  assert.equal(second[0]?.slug, "check-test-suite");
  assert.equal(first[0]?.id, second[0]?.id);
});

test("heartbeat surface keeps entry ids stable when a title is renamed in place", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-heartbeat-title-rename-"));
  const heartbeatPath = path.join(root, "HEARTBEAT.md");
  const surface = createHeartbeatSurface();

  await writeFile(
    heartbeatPath,
    [
      "## check-test-suite",
      "",
      "Run the suite and report new failures.",
      "",
      "Schedule: hourly",
      "",
    ].join("\n"),
    "utf8",
  );

  const first = await surface.read(heartbeatPath);

  await writeFile(
    heartbeatPath,
    [
      "## check-smoke-suite",
      "",
      "Run the suite and report new failures.",
      "",
      "Schedule: hourly",
      "",
    ].join("\n"),
    "utf8",
  );

  const second = await surface.read(heartbeatPath);

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(first[0]?.slug, "check-test-suite");
  assert.equal(second[0]?.slug, "check-smoke-suite");
  assert.equal(first[0]?.id, second[0]?.id);
});

test("heartbeat surface derives non-empty stable slugs from emoji-only titles", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-heartbeat-emoji-slug-"));
  const heartbeatPath = path.join(root, "HEARTBEAT.md");
  const surface = createHeartbeatSurface();

  await writeFile(
    heartbeatPath,
    [
      "## 🔥🔥🔥",
      "",
      "Escalate hot incidents.",
      "",
      "Schedule: hourly",
      "",
    ].join("\n"),
    "utf8",
  );

  const first = await surface.read(heartbeatPath);
  const second = await surface.read(heartbeatPath);

  assert.equal(first.length, 1);
  assert.match(first[0]?.slug ?? "", /^heartbeat-[a-f0-9]{8}$/);
  assert.equal(first[0]?.slug, second[0]?.slug);
  assert.equal(first[0]?.id, second[0]?.id);
});

test("heartbeat surface resolves entries by slug", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-heartbeat-find-"));
  const heartbeatPath = path.join(root, "HEARTBEAT.md");
  await writeFile(
    heartbeatPath,
    [
      "## check-health",
      "",
      "Ping the health endpoint.",
      "",
      "Schedule: hourly",
      "",
    ].join("\n"),
    "utf8",
  );

  const surface = createHeartbeatSurface();
  const entries = await surface.read(heartbeatPath);

  assert.equal(surface.findBySlug(entries, "check-health")?.title, "check-health");
  assert.equal(surface.findBySlug(entries, "missing"), null);
});

test("heartbeat surface watch reacts when HEARTBEAT.md is created after startup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-heartbeat-watch-create-"));
  const heartbeatPath = path.join(root, "HEARTBEAT.md");
  const surface = createHeartbeatSurface();

  const entriesPromise = new Promise<Awaited<ReturnType<typeof surface.read>>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      stop();
      reject(new Error("heartbeat watcher did not fire after file creation"));
    }, 2000);
    const stop = surface.watch(heartbeatPath, (entries) => {
      clearTimeout(timeout);
      stop();
      resolve(entries);
    });
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  await writeFile(
    heartbeatPath,
    [
      "## check-health",
      "",
      "Ping the health endpoint.",
      "",
      "Schedule: hourly",
      "",
    ].join("\n"),
    "utf8",
  );

  const entries = await entriesPromise;
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.slug, "check-health");
});

test("heartbeat surface watch catches callback failures instead of leaking unhandled rejections", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-heartbeat-watch-errors-"));
  const heartbeatPath = path.join(root, "HEARTBEAT.md");
  const surface = createHeartbeatSurface();
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  const stop = surface.watch(heartbeatPath, () => {
    throw new Error("boom");
  });

  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  try {
    await writeFile(
      heartbeatPath,
      [
        "## check-health",
        "",
        "Ping the health endpoint.",
        "",
        "Schedule: hourly",
        "",
      ].join("\n"),
      "utf8",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    console.warn = originalWarn;
    stop();
  }

  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]?.[0] ?? ""), /heartbeat surface watch update failed/);
});

test("heartbeat surface watch recovers when the heartbeat journal directory appears after startup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-heartbeat-watch-missing-dir-"));
  const nestedDir = path.join(root, "missing");
  const heartbeatPath = path.join(nestedDir, "HEARTBEAT.md");
  const surface = createHeartbeatSurface();

  const entriesPromise = new Promise<Awaited<ReturnType<typeof surface.read>>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      stop();
      reject(new Error("heartbeat watcher did not recover after directory creation"));
    }, 2000);
    const stop = surface.watch(heartbeatPath, (entries) => {
      clearTimeout(timeout);
      stop();
      resolve(entries);
    });
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  await mkdir(nestedDir, { recursive: true });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await writeFile(
    heartbeatPath,
    [
      "## recovered-heartbeat",
      "",
      "The watcher survived a missing parent directory.",
      "",
      "Schedule: hourly",
      "",
    ].join("\n"),
    "utf8",
  );

  const entries = await entriesPromise;
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.slug, "recovered-heartbeat");
});
