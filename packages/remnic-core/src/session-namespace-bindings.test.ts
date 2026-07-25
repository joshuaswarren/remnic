import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createFileSessionNamespaceBindingStore,
  createInMemorySessionNamespaceBindingStore,
  SESSION_NAMESPACE_BINDING_MAX_ENTRIES,
  SESSION_NAMESPACE_BINDING_MAX_NAMESPACES,
} from "./session-namespace-bindings.js";

test("session namespace bindings persist prototype-named session keys", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-namespace-bindings-"));
  const filePath = path.join(directory, "session-namespace-bindings.json");
  try {
    const store = createFileSessionNamespaceBindingStore(filePath);
    await store.remember("__proto__", "team-prototype");

    const reloaded = createFileSessionNamespaceBindingStore(filePath);
    assert.deepEqual(await reloaded.namespacesFor("__proto__"), ["team-prototype"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("session namespace bindings propagate malformed-file reads without overwriting them", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-namespace-bindings-"));
  const filePath = path.join(directory, "session-namespace-bindings.json");
  try {
    await writeFile(filePath, "{", "utf8");
    const store = createFileSessionNamespaceBindingStore(filePath);

    await assert.rejects(() => store.namespacesFor("malformed-session"), SyntaxError);
    await assert.rejects(() => store.remember("malformed-session", "team-known"), SyntaxError);
    assert.equal(await readFile(filePath, "utf8"), "{");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session namespace bindings reject structurally invalid files without overwriting them", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-namespace-bindings-"));
  const filePath = path.join(directory, "session-namespace-bindings.json");
  try {
    await writeFile(filePath, JSON.stringify({ entries: null }), "utf8");
    const store = createFileSessionNamespaceBindingStore(filePath);

    await assert.rejects(() => store.namespacesFor("invalid-structure-session"), /invalid structure/);
    await assert.rejects(() => store.remember("invalid-structure-session", "team-known"), /invalid structure/);
    assert.equal(await readFile(filePath, "utf8"), JSON.stringify({ entries: null }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session namespace bindings reject malformed persisted entries", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-namespace-bindings-"));
  const filePath = path.join(directory, "session-namespace-bindings.json");
  const updatedAt = new Date().toISOString();
  const invalidEntries = [
    { "null-entry": null },
    { "missing-namespaces": { updatedAt } },
    { "missing-updated-at": { namespaces: ["team-known"] } },
    { "invalid-namespaces": { namespaces: ["team-known", null], updatedAt } },
  ];
  try {
    for (const entries of invalidEntries) {
      const raw = JSON.stringify({ version: 1, entries });
      await writeFile(filePath, raw, "utf8");
      const store = createFileSessionNamespaceBindingStore(filePath);

      await assert.rejects(
        () => store.namespacesFor("invalid-entry-session"),
        /entry has invalid structure/,
      );
      await assert.rejects(
        () => store.remember("invalid-entry-session", "team-known"),
        /entry has invalid structure/,
      );
      assert.equal(await readFile(filePath, "utf8"), raw);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session namespace bindings retain concurrent scope observations", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-namespace-bindings-"));
  const filePath = path.join(directory, "session-namespace-bindings.json");
  try {
    await Promise.all([
      createFileSessionNamespaceBindingStore(filePath).remember("session-1", "team-first"),
      createFileSessionNamespaceBindingStore(filePath).remember("session-1", "team-second"),
    ]);

    const reloaded = createFileSessionNamespaceBindingStore(filePath);
    assert.deepEqual((await reloaded.namespacesFor("session-1")).sort(), ["team-first", "team-second"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session namespace bindings persist an explicit default scope", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-namespace-bindings-"));
  const filePath = path.join(directory, "session-namespace-bindings.json");
  try {
    const store = createFileSessionNamespaceBindingStore(filePath);
    await store.remember("session-1", "team-named");
    await store.remember("session-1", "");

    const reloaded = createFileSessionNamespaceBindingStore(filePath);
    assert.deepEqual(await reloaded.namespacesFor("session-1"), ["team-named", ""]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session namespace bindings prune expired and overflowed persisted history", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-namespace-bindings-"));
  const filePath = path.join(directory, "session-namespace-bindings.json");
  const now = Date.now();
  const entries = Object.fromEntries(
    Array.from({ length: 1_000 }, (_unused, index) => [
      `session-${index}`,
      {
        namespaces: [`team-${index}`],
        updatedAt: new Date(now - index).toISOString(),
      },
    ])
  ) as Record<string, { namespaces: string[]; updatedAt: string }>;
  entries["stale-session"] = {
    namespaces: ["team-stale"],
    updatedAt: new Date(now - 8 * 24 * 60 * 60 * 1_000).toISOString(),
  };
  try {
    await writeFile(filePath, JSON.stringify({ version: 1, entries }), "utf8");
    const store = createFileSessionNamespaceBindingStore(filePath);

    assert.deepEqual(await store.namespacesFor("stale-session"), []);
    await store.remember("current-session", "team-current");

    const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
      entries: Record<string, { namespaces: string[] }>;
    };
    assert.equal(Object.keys(persisted.entries).length, 1_000);
    assert.equal("stale-session" in persisted.entries, false);
    assert.deepEqual(await store.namespacesFor("current-session"), ["team-current"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("in-memory session namespace bindings cap inactive routing history", async () => {
  const store = createInMemorySessionNamespaceBindingStore();
  for (let index = 0; index <= 1_000; index += 1) {
    await store.remember(`session-${index}`, `team-${index}`);
  }

  assert.deepEqual(await store.namespacesFor("session-0"), []);
  assert.deepEqual(await store.namespacesFor("session-1000"), ["team-1000"]);
});

test("in-memory session namespace bindings retain sparse active sessions", async () => {
  const store = createInMemorySessionNamespaceBindingStore();
  for (let index = 0; index < SESSION_NAMESPACE_BINDING_MAX_ENTRIES; index += 1) {
    await store.remember(`session-${index}`, `team-${index}`);
  }

  assert.deepEqual(await store.namespacesFor("session-0"), ["team-0"]);
  await store.remember("overflow-session", "team-overflow");

  assert.deepEqual(await store.namespacesFor("session-0"), ["team-0"]);
  assert.deepEqual(await store.namespacesFor("session-1"), []);
});

test("session namespace bindings refresh a sparse active binding", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-namespace-bindings-"));
  const filePath = path.join(directory, "session-namespace-bindings.json");
  const updatedAt = new Date(Date.now() - 60 * 60 * 1_000).toISOString();
  try {
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        entries: {
          "active-session": { namespaces: ["team-active"], updatedAt },
        },
      }),
      "utf8",
    );
    const store = createFileSessionNamespaceBindingStore(filePath);

    assert.deepEqual(await store.namespacesFor("active-session"), ["team-active"]);

    const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
      entries: Record<string, { updatedAt: string }>;
    };
    assert.ok(Date.parse(persisted.entries["active-session"].updatedAt) > Date.parse(updatedAt));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session namespace bindings return known scope when timestamp refresh fails", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-namespace-bindings-"));
  const filePath = path.join(directory, "session-namespace-bindings.json");
  const updatedAt = new Date(Date.now() - 60 * 60 * 1_000).toISOString();
  try {
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        entries: {
          "refresh-failure-session": { namespaces: ["team-known"], updatedAt },
        },
      }),
      "utf8",
    );
    let writeAttempts = 0;
    const store = createFileSessionNamespaceBindingStore(filePath, {
      writeBindingFile: async () => {
        writeAttempts += 1;
        throw new Error("forced refresh write failure");
      },
    });

    assert.deepEqual(await store.namespacesFor("refresh-failure-session"), ["team-known"]);
    assert.equal(writeAttempts, 1);

    const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
      entries: Record<string, { updatedAt: string }>;
    };
    assert.equal(persisted.entries["refresh-failure-session"].updatedAt, updatedAt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session namespace bindings retain failed refreshes in volatile state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-namespace-bindings-"));
  const filePath = path.join(directory, "session-namespace-bindings.json");
  const updatedAt = new Date(Date.now() - 60 * 60 * 1_000).toISOString();
  try {
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        entries: {
          "volatile-refresh-session": { namespaces: ["team-known"], updatedAt },
        },
      }),
      "utf8",
    );
    const store = createFileSessionNamespaceBindingStore(filePath, {
      writeBindingFile: async () => {
        throw new Error("forced refresh write failure");
      },
    });

    assert.deepEqual(await store.namespacesFor("volatile-refresh-session"), ["team-known"]);
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        entries: {
          "volatile-refresh-session": {
            namespaces: ["team-known"],
            updatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString(),
          },
        },
      }),
      "utf8",
    );
    assert.deepEqual(await store.namespacesFor("volatile-refresh-session"), ["team-known"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session namespace bindings cap each session's namespace history", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-namespace-bindings-"));
  const filePath = path.join(directory, "session-namespace-bindings.json");
  try {
    const fileStore = createFileSessionNamespaceBindingStore(filePath);
    const memoryStore = createInMemorySessionNamespaceBindingStore();
    for (let index = 0; index <= SESSION_NAMESPACE_BINDING_MAX_NAMESPACES; index += 1) {
      const namespace = `team-${index}`;
      await fileStore.remember("rebound-session", namespace);
      await memoryStore.remember("rebound-session", namespace);
    }

    const expected = Array.from(
      { length: SESSION_NAMESPACE_BINDING_MAX_NAMESPACES },
      (_unused, index) => `team-${index + 1}`,
    );
    assert.deepEqual(await fileStore.namespacesFor("rebound-session"), expected);
    assert.deepEqual(await memoryStore.namespacesFor("rebound-session"), expected);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
