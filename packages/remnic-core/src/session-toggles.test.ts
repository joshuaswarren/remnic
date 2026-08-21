import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";

import { createFileToggleStore } from "./session-toggles.js";

test("createFileToggleStore round-trips disabled state for encoded session keys", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-toggle-store-"));
  const filePath = path.join(root, "session-toggles.json");
  const store = createFileToggleStore(filePath);

  await store.setDisabled("agent/main/session/1", "main-agent", true);

  assert.equal(await store.isDisabled("agent/main/session/1", "main-agent"), true);
  assert.equal(await store.isDisabled("agent/main/session/1", "other-agent"), false);

  const raw = JSON.parse(await readFile(filePath, "utf8")) as {
    version: number;
    entries: Record<string, { disabled: boolean; updatedAt: string }>;
  };
  assert.equal(raw.version, 1);
  assert.equal(Object.keys(raw.entries).length, 1);
});

test("createFileToggleStore lists and clears keys containing the separator", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-toggle-store-separator-"));
  const filePath = path.join(root, "session-toggles.json");
  const store = createFileToggleStore(filePath);

  await store.setDisabled("pi::session", "agent::one", true);

  assert.equal(await store.isDisabled("pi::session", "agent::one"), true);
  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.sessionKey, "pi::session");
  assert.equal(listed[0]?.agentId, "agent::one");
  assert.equal(listed[0]?.disabled, true);

  await store.clear("pi::session", "agent::one");

  assert.equal(await store.isDisabled("pi::session", "agent::one"), false);
  assert.deepEqual(await store.list(), []);
});

test("createFileToggleStore recovers from malformed primary store contents", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-toggle-store-bad-"));
  const filePath = path.join(root, "session-toggles.json");
  await writeFile(filePath, "{ definitely not json", "utf8");

  const store = createFileToggleStore(filePath);
  assert.equal(await store.isDisabled("session-a", "agent-a"), false);

  await store.setDisabled("session-a", "agent-a", true);
  assert.equal(await store.isDisabled("session-a", "agent-a"), true);
});

test("createFileToggleStore honors read-through bundled active-memory toggles", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-toggle-store-shared-"));
  const primaryPath = path.join(root, "remnic-session-toggles.json");
  const bundledPath = path.join(root, "bundled-session-toggles.json");
  const encodedKey = `${encodeURIComponent("session-a")}::${encodeURIComponent("agent-a")}`;

  await writeFile(
    bundledPath,
    JSON.stringify(
      {
        version: 1,
        entries: {
          [encodedKey]: {
            disabled: true,
            updatedAt: "2026-04-12T12:00:00Z",
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const store = createFileToggleStore(primaryPath, {
    secondaryReadOnlyPath: bundledPath,
  });

  assert.equal(await store.isDisabled("session-a", "agent-a"), true);
  assert.deepEqual(await store.resolve("session-a", "agent-a"), {
    disabled: true,
    source: "secondary",
    updatedAt: "2026-04-12T12:00:00Z",
  });
  await store.setDisabled("session-a", "agent-a", false);
  assert.equal(await store.isDisabled("session-a", "agent-a"), false);
  assert.equal((await store.resolve("session-a", "agent-a")).source, "primary");
  await store.clear("session-a", "agent-a");
  assert.equal(await store.isDisabled("session-a", "agent-a"), true);
  assert.equal((await store.resolve("session-a", "agent-a")).source, "secondary");
});

test("createFileToggleStore recovers queued writes after a prior write failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-toggle-store-recover-"));
  const filePath = path.join(root, "session-toggles.json");
  const store = createFileToggleStore(filePath);

  await chmod(root, 0o555);
  await assert.rejects(
    store.setDisabled("session-a", "agent-a", true),
    /EACCES|EPERM/,
  );

  await chmod(root, 0o755);
  await store.setDisabled("session-a", "agent-a", true);

  assert.equal(await store.isDisabled("session-a", "agent-a"), true);
});
