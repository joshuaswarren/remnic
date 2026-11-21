import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import os from "node:os";
import path from "node:path";
import {
  QmdClient, resolveQmdCapabilities, retainSharedDaemonSessionForTest, releaseSharedDaemonSessionForTest,
} from "./qmd.js";
import { NamespaceSearchRouter } from "./namespaces/search.js";
import { parseConfig } from "./config.js";
import type { JsonValue } from "./extraction-reply-diagnostic.js";

const NAMES = [
  "HOME", "USERPROFILE", "PATH", "XDG_CONFIG_HOME", "XDG_CACHE_HOME",
  "QMD_CONFIG_DIR", "INDEX_PATH", "QMD_EMBED_MODEL", "QMD_GENERATE_MODEL",
  "QMD_RERANK_MODEL", "QMD_FORCE_CPU", "QMD_LLAMA_GPU", "QMD_EMBED_PARALLELISM",
  "QMD_EMBED_CONTEXT_SIZE", "QMD_EXPAND_CONTEXT_SIZE", "QMD_RERANK_CONTEXT_SIZE", "QMD_SOURCE_MODE",
  "PWD", "WSL_DISTRO_NAME", "WSL_INTEROP",
];
const memoryDir = path.join(os.tmpdir(), "fixture-notes");
const collection = "fixture-notes";
let fixtureId = 0;

function hash(value: JsonValue): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function packet() {
  return { structuredContent: { health: {
    schemaVersion: 1,
    environment: {
      names: NAMES,
      digest: hash([process.cwd(), NAMES.map(name => [name, process.env[name] ?? null])]),
    },
    active: { index: hash("fixture-index"), configuration: hash("fixture-config"), embeddingModel: hash("fixture-model") },
    current: { index: hash("fixture-index"), configuration: hash("fixture-config"), embeddingModel: hash("fixture-model") },
    countModel: hash("fixture-model"),
    pendingEmbeddings: 0,
    catalog: { complete: true, entries: [{ name: hash(collection), path: hash(memoryDir), documents: 0 }] },
  } } };
}

async function operationalClient(
  t: TestContext,
  respond: () => JsonValue | Promise<JsonValue> = packet,
  advertisement: { marker?: JsonValue } = { marker: { schemaVersion: 1 } },
) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let spawnCalls = 0;
  let initializeCalls = 0;
  let statusCalls = 0;
  let capabilityCalls = 0;
  let cliCalls = 0;
  const stdin = new Writable({
    write(chunk, _encoding, done) {
      const message = JSON.parse(chunk.toString());
      done();
      if (message.id === undefined) return;
      queueMicrotask(() => {
        void (async () => {
          let result: JsonValue;
          if (message.method === "initialize") {
            initializeCalls++;
            result = {
              capabilities: {
                experimental: advertisement.marker === undefined ? {} : { "qmd/healthMetadata": advertisement.marker },
              },
              serverInfo: { name: "fixture", version: "2.8.3" },
            };
          } else if (message.method === "tools/list") {
            capabilityCalls++;
            throw new Error("Health must not discover tools");
          } else {
            assert.equal(message.method, "tools/call");
            assert.equal(message.params.name, "status");
            statusCalls++;
            result = await respond();
          }
          stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
        })().catch(() => stdout.write(JSON.stringify({
          jsonrpc: "2.0", id: message.id, error: { code: -1, message: "Synthetic RPC failure" },
        }) + "\n"));
      });
    },
  });
  const child = Object.assign(new EventEmitter(), {
    stdout, stderr, stdin, killed: false,
    kill() {
      child.killed = true;
      queueMicrotask(() => child.emit("close", 0));
      return true;
    },
  });
  const binary = `fixture-qmd-health-${++fixtureId}`;
  const session = retainSharedDaemonSessionForTest(binary, {}, undefined, "2.8.3");
  Object.assign(session, { spawn: () => { spawnCalls++; return child; } });
  const client = new QmdClient(collection, 3, {
    qmdPath: binary, daemonUrl: "stdio://fixture", qmdSupportedVersion: "2.8.3",
  });
  Object.assign(client, {
    available: true,
    daemonAvailable: true,
    daemonSession: session,
    daemonSessionPath: [binary, "", "2.8.3"].join("\0"),
    cliVersion: "2.8.3",
    qmdCapabilities: resolveQmdCapabilities("2.8.3"),
    runQmdCommand: async () => { cliCalls++; throw new Error("No CLI work on operational metadata path"); },
    probeDaemon: async () => { throw new Error("Health must not probe"); },
  });
  t.after(async () => {
    await client.dispose();
    stdin.destroy(); stdout.destroy(); stderr.destroy();
    assert.equal(cliCalls, 0);
    assert.equal(capabilityCalls, 0);
    assert.equal(spawnCalls, 1);
  });
  assert.deepEqual(await Promise.all([session.start(), session.start()]), [true, true]);
  assert.equal(initializeCalls, 1);
  return {
    client, session, binary,
    initializeCalls: () => initializeCalls,
    statusCalls: () => statusCalls,
    capabilityCalls: () => capabilityCalls,
  };
}

test("operational health accepts a configured-empty collection with fresh same-model counts", async t => {
  const fixture = await operationalClient(t);
  const health = await fixture.client.readOperationalHealth(memoryDir);
  assert.equal(health?.collectionState, "present");
  assert.equal(health?.totalFiles, 0);
  assert.equal(health?.pendingEmbeddings, 0);
  assert.equal(fixture.session.isActive(), true);
  assert.equal(health?.isCurrent?.(), true);
  assert.equal(fixture.statusCalls(), 1);
  assert.equal(fixture.capabilityCalls(), 0);
});

test("operational health passively recognizes old capability without calling its status reader", async t => {
  const fixture = await operationalClient(t, packet, {});
  assert.equal(await fixture.client.readOperationalHealth(memoryDir), undefined);
  assert.equal(fixture.statusCalls(), 0);
});

test("operational health refuses an unsupported advertised capability without CLI retry", async t => {
  const fixture = await operationalClient(t, packet, { marker: { schemaVersion: 99 } });
  assert.equal((await fixture.client.readOperationalHealth(memoryDir))?.collectionState, "unknown");
  assert.equal(fixture.statusCalls(), 0);
});

for (const marker of [
  null, "1", true, 1, {}, [], { schemaVersion: "1" }, { schemaVersion: null },
  { schemaVersion: true }, { schemaVersion: 0 }, { schemaVersion: 1, unsupported: true },
]) {
  test(`operational health refuses malformed advertised marker ${JSON.stringify(marker)}`, { timeout: 2_000 }, async t => {
    const fixture = await operationalClient(t, packet, { marker });
    assert.equal(fixture.session.getHealthMetadataCapability(), "invalid");
    assert.equal((await fixture.client.readOperationalHealth(memoryDir))?.collectionState, "unknown");
    assert.equal(fixture.statusCalls(), 0);
  });
}

test("concurrent health reads reuse passive discovery and each send exactly one snapshot RPC", { timeout: 2_000 }, async t => {
  const fixture = await operationalClient(t);
  assert.equal(fixture.session.getHealthMetadataCapability(), "available");
  assert.equal(fixture.initializeCalls(), 1);
  assert.equal(fixture.statusCalls(), 0);
  const snapshots = await Promise.all([
    fixture.client.readOperationalHealth(memoryDir),
    fixture.client.readOperationalHealth(memoryDir),
  ]);
  assert.deepEqual(snapshots.map(snapshot => snapshot?.collectionState), ["present", "present"]);
  assert.equal(fixture.statusCalls(), 2);
  assert.equal(fixture.capabilityCalls(), 0);
  assert.equal(fixture.initializeCalls(), 1);
  for (const snapshot of snapshots) {
    assert.equal(snapshot?.isCurrent?.(), true);
    assert.equal(snapshot?.isCurrent?.(), true);
  }
  assert.equal(fixture.statusCalls(), 2, "Publishability checks must not send RPCs");
  await fixture.client.dispose();
  assert.equal(fixture.session.isActive(), false, "Health must not retain a session lease");
  assert.equal(snapshots[0]?.isCurrent?.(), false);
  assert.equal(snapshots[1]?.isCurrent?.(), false);
});

test("operational health reads fresh metadata after a healthy result while caching only static capability", async t => {
  let changed = false;
  const fixture = await operationalClient(t, () => {
    const value = packet();
    if (changed) value.structuredContent.health.current.embeddingModel = hash("changed-model");
    return value;
  });
  assert.equal((await fixture.client.readOperationalHealth(memoryDir))?.collectionState, "present");
  changed = true;
  assert.equal((await fixture.client.readOperationalHealth(memoryDir))?.collectionState, "unknown");
  assert.equal(fixture.statusCalls(), 2);
  assert.equal(fixture.capabilityCalls(), 0);
  assert.equal(fixture.initializeCalls(), 1);
});

test("operational health reports real model-bound backlog rather than hiding it", async t => {
  const fixture = await operationalClient(t, () => {
    const value = packet();
    value.structuredContent.health.pendingEmbeddings = 50_000;
    return value;
  });
  const health = await fixture.client.readOperationalHealth(memoryDir);
  assert.equal(health?.collectionState, "present");
  assert.equal(health?.pendingEmbeddings, 50_000);
});

test("operational health returns missing for authoritative removal despite stale active configuration", async t => {
  const fixture = await operationalClient(t, () => {
    const value = packet();
    value.structuredContent.health.current.configuration = hash("removed-configuration");
    value.structuredContent.health.catalog.entries = [];
    return value;
  });
  assert.equal((await fixture.client.readOperationalHealth(memoryDir))?.collectionState, "missing");
});

test("operational health refuses malformed counts even when the catalog is empty", async t => {
  let corruptModel = false;
  const fixture = await operationalClient(t, () => {
    const value = packet();
    const health = value.structuredContent.health;
    health.catalog.entries = [];
    if (corruptModel) health.countModel = hash("wrong-model");
    else health.pendingEmbeddings = -1;
    return value;
  });
  assert.equal((await fixture.client.readOperationalHealth(memoryDir))?.collectionState, "unknown");
  corruptModel = true;
  assert.equal((await fixture.client.readOperationalHealth(memoryDir))?.collectionState, "unknown");
});

const corruptions: Array<[string, (value: ReturnFixture) => JsonValue]> = [
  ["null metadata", () => ({ structuredContent: { health: null } })],
  ["missing advertised metadata", () => ({ structuredContent: {} })],
  ["unsupported schema", value => { value.structuredContent.health.schemaVersion = 99; return value; }],
  ["wrong index", value => { value.structuredContent.health.current.index = hash("foreign-index"); return value; }],
  ["changed configuration", value => { value.structuredContent.health.current.configuration = hash("changed"); return value; }],
  ["wrong collection path", value => { value.structuredContent.health.catalog.entries[0]!.path = hash("foreign-path"); return value; }],
  ["count model mismatch", value => { value.structuredContent.health.countModel = hash("wrong-model"); return value; }],
  ["incomplete catalog", value => { value.structuredContent.health.catalog.complete = false; return value; }],
  ["invalid count", value => { value.structuredContent.health.pendingEmbeddings = -1; return value; }],
  ["RPC tool failure", () => ({ isError: true, structuredContent: {} })],
];

type ReturnFixture = {
  structuredContent: {
    health: {
      schemaVersion: number;
      environment: { names: string[]; digest: string };
      active: { index: string; configuration: string; embeddingModel: string };
      current: { index: string; configuration: string; embeddingModel: string };
      countModel: string;
      pendingEmbeddings: number;
      catalog: { complete: boolean; entries: Array<{ name: string; path: string; documents: number }> };
    };
  };
};

for (const [name, corrupt] of corruptions) {
  test(`operational health refuses ${name}`, async t => {
    const fixture = await operationalClient(t, () => corrupt(packet()));
    assert.equal((await fixture.client.readOperationalHealth(memoryDir))?.collectionState, "unknown");
  });
}

for (const flag of [true, "false", null, 0, {}, []]) {
  for (const name of ["isError", "unavailable"] as const) {
    test(`operational health refuses ${name}=${JSON.stringify(flag)} at the RPC boundary`, { timeout: 2_000 }, async t => {
      const fixture = await operationalClient(t, () => {
        const value = packet();
        Object.assign(name === "isError" ? value : value.structuredContent.health, { [name]: flag });
        return value;
      });
      const health = await fixture.client.readOperationalHealth(memoryDir);
      assert.equal(health?.collectionState, "unknown");
      assert.equal(health?.pendingEmbeddings, null);
      assert.equal(fixture.statusCalls(), 1);
    });
  }
}

test("operational health accepts literal false error and unavailable flags", { timeout: 2_000 }, async t => {
  const fixture = await operationalClient(t, () => {
    const value = packet();
    Object.assign(value, { isError: false });
    Object.assign(value.structuredContent.health, { unavailable: false });
    return value;
  });
  assert.equal((await fixture.client.readOperationalHealth(memoryDir))?.collectionState, "present");
});

test("operational health requires the exact native environment key contract", { timeout: 2_000 }, async t => {
  const fixture = await operationalClient(t, () => {
    const value = packet();
    value.structuredContent.health.environment.names = NAMES.filter(name => name !== "QMD_EMBED_CONTEXT_SIZE");
    return value;
  });
  assert.equal((await fixture.client.readOperationalHealth(memoryDir))?.collectionState, "unknown");
});

test("operational health refuses inherited environment drift before or during RPC", async t => {
  const old = process.env.QMD_EMBED_MODEL;
  const original = packet();
  t.after(() => { if (old === undefined) delete process.env.QMD_EMBED_MODEL; else process.env.QMD_EMBED_MODEL = old; });
  const fixture = await operationalClient(t, () => original);
  process.env.QMD_EMBED_MODEL = "fixture:changed-before-rpc";
  assert.equal((await fixture.client.readOperationalHealth(memoryDir))?.collectionState, "unknown");
  if (old === undefined) delete process.env.QMD_EMBED_MODEL; else process.env.QMD_EMBED_MODEL = old;
  const during = await operationalClient(t, () => {
    const value = packet();
    process.env.QMD_EMBED_MODEL = "fixture:changed-during-rpc";
    return value;
  });
  assert.equal((await during.client.readOperationalHealth(memoryDir))?.collectionState, "unknown");
});

test("operational health refuses pre-abort and a late result after session invalidation", async t => {
  const aborted = new AbortController();
  aborted.abort();
  const fixture = await operationalClient(t);
  assert.equal((await fixture.client.readOperationalHealth(memoryDir, { signal: aborted.signal }))?.collectionState, "unknown");
  assert.equal(fixture.statusCalls(), 0);
  const late = await operationalClient(t, async () => {
    late.session.invalidate();
    return packet();
  });
  assert.equal((await late.client.readOperationalHealth(memoryDir))?.collectionState, "unknown");
});

test("operational health refuses RPC cancellation without killing the owned session", async t => {
  const controller = new AbortController();
  const fixture = await operationalClient(t, () => {
    controller.abort();
    return packet();
  });
  assert.equal((await fixture.client.readOperationalHealth(memoryDir, { signal: controller.signal }))?.collectionState, "unknown");
  assert.equal(fixture.session.isActive(), true);
});

test("operational health does not start a cold client", async () => {
  const client = new QmdClient(collection, 3, { daemonUrl: "stdio://fixture" });
  Object.assign(client, { probeDaemon: async () => { throw new Error("Unexpected process acquisition"); } });
  assert.equal(await client.readOperationalHealth(memoryDir), undefined);
});

test("operational health refuses an elapsed absolute deadline before timers can fire", { timeout: 2_000 }, async t => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const fixture = await operationalClient(t, () => {
    now = 5_001;
    return packet();
  });
  const health = await fixture.client.readOperationalHealth(memoryDir);
  assert.equal(health?.collectionState, "unknown");
  assert.equal(health?.pendingEmbeddings, null);
  assert.equal(health?.isCurrent?.(), false);
  assert.equal(fixture.statusCalls(), 1);
  assert.equal(fixture.session.isActive(), true);
});

test("snapshot publishability expires at its absolute monotonic deadline", { timeout: 2_000 }, async t => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const fixture = await operationalClient(t);
  const health = await fixture.client.readOperationalHealth(memoryDir);
  assert.equal(health?.isCurrent?.(), true);
  now = 5_000;
  assert.equal(health?.isCurrent?.(), false);
  assert.equal(fixture.statusCalls(), 1);
});

test("snapshot publishability ends on client release even while another owner keeps the process alive", { timeout: 2_000 }, async t => {
  const fixture = await operationalClient(t);
  const otherOwner = retainSharedDaemonSessionForTest(fixture.binary, {}, undefined, "2.8.3");
  t.after(() => releaseSharedDaemonSessionForTest(otherOwner));
  const health = await fixture.client.readOperationalHealth(memoryDir);
  assert.equal(health?.isCurrent?.(), true);
  const disposal = fixture.client.dispose();
  assert.equal(health?.isCurrent?.(), false, "Release invalidates before its first await");
  assert.equal(fixture.client.operationalHealthIdentity(), null);
  await disposal;
  assert.equal(otherOwner.isActive(), true);
});

test("snapshot publishability ends on process invalidation and capability resets", { timeout: 2_000 }, async t => {
  const fixture = await operationalClient(t);
  const health = await fixture.client.readOperationalHealth(memoryDir);
  assert.equal(health?.isCurrent?.(), true);
  fixture.session.invalidate();
  assert.equal(fixture.session.getHealthMetadataCapability(), null);
  assert.equal(health?.isCurrent?.(), false);
});

for (const [name, patch] of [
  ["generation", { daemonGeneration: 1 }],
  ["owner path", { daemonSessionPath: "other-owner" }],
  ["binary", { qmdPath: "other-binary" }],
  ["version", { cliVersion: "2.8.4" }],
  ["capabilities", { qmdCapabilities: resolveQmdCapabilities("2.8.3") }],
  ["index", { qmdIndexName: "other-index" }],
  ["runtime environment", { qmdRuntimeEnv: { QMD_EMBED_CONTEXT_SIZE: "8192" } }],
] as const) {
  test(`snapshot publishability ends on client ${name} change`, { timeout: 2_000 }, async t => {
    const fixture = await operationalClient(t);
    const health = await fixture.client.readOperationalHealth(memoryDir);
    assert.equal(health?.isCurrent?.(), true);
    Object.assign(fixture.client, patch);
    assert.equal(health?.isCurrent?.(), false);
    assert.equal(fixture.statusCalls(), 1);
  });
}

test("snapshot publishability ends on inherited environment, cwd, or abort changes", { timeout: 2_000 }, async t => {
  const old = process.env.QMD_EMBED_CONTEXT_SIZE;
  const restore = () => {
    if (old === undefined) delete process.env.QMD_EMBED_CONTEXT_SIZE;
    else process.env.QMD_EMBED_CONTEXT_SIZE = old;
  };
  t.after(restore);
  const fixture = await operationalClient(t);
  const controller = new AbortController();
  const health = await fixture.client.readOperationalHealth(memoryDir, { signal: controller.signal });
  assert.equal(health?.isCurrent?.(), true);
  process.env.QMD_EMBED_CONTEXT_SIZE = `${old ?? ""}-changed`;
  assert.equal(health?.isCurrent?.(), false);
  restore();
  const originalCwd = process.cwd();
  const cwd = t.mock.method(process, "cwd", () => path.join(originalCwd, "changed"));
  assert.equal(health?.isCurrent?.(), false);
  cwd.mock.restore();
  controller.abort();
  assert.equal(health?.isCurrent?.(), false);
});

for (const [pausedStorageCall, absentCapability] of [[1, false], [2, false], [1, true], [2, true]] as const) {
  test(`router refuses actual client invalidation across storage await ${pausedStorageCall} (absent=${absentCapability})`, { timeout: 2_000 }, async t => {
    const fixture = await operationalClient(t, packet, absentCapability ? {} : { marker: { schemaVersion: 1 } });
    const replacement = absentCapability ? await operationalClient(t, packet, {}) : null;
    const identity = fixture.client.operationalHealthIdentity();
    assert.notEqual(identity, null);
    const { promise: paused, resolve: entered } = Promise.withResolvers<void>();
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    t.after(() => release());
    t.mock.method(fixture.client, "probe", async () => true);
    t.mock.method(fixture.client, "checkCollection", async () => "present");
    let storageCalls = 0;
    let created = 0;
    const router = new NamespaceSearchRouter(parseConfig({
      defaultNamespace: "main", memoryDir, qmdCollection: collection,
      qmdEnabled: true, qmdEmbeddingBacklogThreshold: 100,
    }), {
      storageFor: async () => {
        if (created > 0 && ++storageCalls === pausedStorageCall) {
          entered();
          await gate;
        }
        return { dir: memoryDir };
      },
    }, () => {
      if (++created === 1) return fixture.client;
      throw new Error("Ownership loss must not fall back to a diagnostic backend");
    });
    await router.ensureNamespaceCollection("main");
    t.after(() => router.dispose());
    const pending = router.healthForNamespace("main");
    await paused;
    if (replacement) Object.assign(fixture.client, { daemonSession: replacement.session });
    else if (pausedStorageCall === 1) await fixture.client.dispose();
    else fixture.session.invalidate();
    assert.notEqual(fixture.client.operationalHealthIdentity(), identity);
    release();
    try {
      const health = await pending;
      assert.equal(health.collectionState, "unknown");
      assert.equal(health.pendingEmbeddings, null);
      assert.equal(created, 1);
      assert.equal(fixture.statusCalls(), absentCapability ? 0 : pausedStorageCall - 1);
      assert.equal(fixture.capabilityCalls(), 0);
    } finally {
      if (replacement) Object.assign(fixture.client, { daemonSession: fixture.session });
    }
  });
}
