import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createFileSessionNamespaceBindingStore } from "./session-namespace-bindings.js";

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
