import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EngramAccessHttpServer } from "./access-http.js";
import { EngramAccessService } from "./access-service.js";
import { Orchestrator } from "./orchestrator.js";
import { parseConfig } from "./config.js";
import { writePeer, writePeerProfile } from "./peers/index.js";

// Issue #3225 B3: the HTTP peer routes dispatch to global stores, so REST
// must enforce the same operation policy as MCP — a namespace-scoped token
// (any namespaces axis, including []) must be denied before any file in the
// store changes, while ops-scoped and legacy tokens keep working.

const PEER_ID = "b3-target-peer";
const NOW = "2026-11-11T00:00:00.000Z";

async function createService(): Promise<{ root: string; service: EngramAccessService; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-http-peer-fleet-wide-"));
  const orchestrator = new Orchestrator(
    parseConfig({ memoryDir: root, namespacesEnabled: false, defaultNamespace: "global" }),
  );
  const storage = await orchestrator.getStorage();
  await storage.ensureDirectories();
  await writePeer(root, {
    id: PEER_ID,
    kind: "agent",
    displayName: "seeded peer",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await writePeerProfile(root, {
    peerId: PEER_ID,
    updatedAt: NOW,
    fields: { communication_style: "seeded" },
    provenance: {},
  });
  return { root, service: new EngramAccessService(orchestrator), cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** Sorted relpath:content lines for every file under root (mutation detector). */
async function snapshotDir(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const lines: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const abs = path.join(entry.parentPath, entry.name);
    const content = await readFile(abs, "utf8");
    lines.push(`${path.relative(root, abs)}:${content}`);
  }
  return lines.sort();
}

test("HTTP peer routes deny namespace-scoped tokens before the stores, REST policy matches MCP (issue #3225 B3)", async () => {
  const { root, service, cleanup } = await createService();
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authToken: "legacy-operator",
    authTokenEntriesGetter: () => [
      { token: "ns-scoped", capabilities: { version: 1, namespaces: ["ns_a"] } },
      { token: "ns-empty", capabilities: { version: 1, namespaces: [] } },
      {
        token: "ops-peer",
        capabilities: {
          version: 1,
          ops: ["peer_list", "peer_get", "peer_set", "peer_delete", "peer_profile_get", "peer_forget"],
        },
      },
    ],
    adminConsoleEnabled: false,
  });
  const status = await server.start();
  const call = (token: string, pathname: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${status.port}${pathname}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    });

  try {
    const before = await snapshotDir(root);

    // Namespace-scoped token (single namespace): every peer route is denied
    // BEFORE the store is touched — including the destructive purge.
    assert.equal((await call("ns-scoped", "/engram/v1/peers")).status, 403, "peer_list denied");
    assert.equal((await call("ns-scoped", `/engram/v1/peers/${PEER_ID}`)).status, 403, "peer_get denied");
    assert.equal(
      (await call("ns-scoped", `/engram/v1/peers/${PEER_ID}`, { method: "PUT", body: JSON.stringify({ displayName: "hijack" }) })).status,
      403,
      "peer_set denied",
    );
    assert.equal((await call("ns-scoped", `/engram/v1/peers/${PEER_ID}`, { method: "DELETE" })).status, 403, "peer_delete denied");
    assert.equal(
      (
        await call("ns-scoped", `/engram/v1/peers/${PEER_ID}?forget=true`, {
          method: "DELETE",
          body: JSON.stringify({ confirm: "yes" }),
        })
      ).status,
      403,
      "peer_forget denied",
    );
    assert.equal((await call("ns-scoped", `/engram/v1/peers/${PEER_ID}/profile`)).status, 403, "peer_profile_get denied");

    // Empty namespace allow-list: denied too.
    assert.equal((await call("ns-empty", "/engram/v1/peers")).status, 403, "empty namespace list denied");

    // Denials never reached the stores — no file read effect, no mutation.
    assert.deepEqual(await snapshotDir(root), before, "denied requests must not change any peer file");

    // An ops-scoped token without a namespace axis keeps full peer access.
    const listed = await call("ops-peer", "/engram/v1/peers");
    assert.equal(listed.status, 200, "ops-scoped token lists peers");
    // SAFETY: the peer_list REST route returns the service envelope { peers }.
    const listedBody = (await listed.json()) as { peers: { id: string }[] };
    assert.deepEqual(listedBody.peers.map((p) => p.id), [PEER_ID], "ops-scoped token sees the seeded peer");

    const created = await call("ops-peer", "/engram/v1/peers/ops-peer-1", {
      method: "PUT",
      body: JSON.stringify({ displayName: "ops token peer" }),
    });
    assert.equal(created.status, 201, "ops-scoped token registers a peer");
    // SAFETY: the peer_set REST route returns the upsert outcome { created, peer }.
    const createdBody = (await created.json()) as { created: boolean; peer: { displayName: string } };
    assert.equal(createdBody.created, true);
    assert.equal(createdBody.peer.displayName, "ops token peer");

    const purged = await call("ops-peer", "/engram/v1/peers/ops-peer-1?forget=true", {
      method: "DELETE",
      body: JSON.stringify({ confirm: "yes" }),
    });
    assert.equal(purged.status, 200, "ops-scoped token purges a peer");
    await purged.text();
    const afterPurge = await snapshotDir(root);
    assert.ok(
      !afterPurge.some((line) => line.startsWith("peers/ops-peer-1/")),
      "the destructive purge removed the peer directory",
    );

    // Legacy unrestricted token (static authToken, no capability record).
    const legacyList = await call("legacy-operator", "/engram/v1/peers");
    assert.equal(legacyList.status, 200, "legacy token lists peers");
    await legacyList.text();

    // Peer-forget confirmation behavior is unchanged: no confirm body, no purge.
    const unconfirmed = await call("legacy-operator", `/engram/v1/peers/${PEER_ID}?forget=true`, {
      method: "DELETE",
      body: JSON.stringify({}),
    });
    assert.equal(unconfirmed.status, 400, "missing confirm still fails with 400");
    assert.match(await unconfirmed.text(), /confirm_required/);
    const seededIntact = await snapshotDir(root);
    assert.ok(
      seededIntact.some((line) => line.startsWith(`peers/${PEER_ID}/identity.md`)),
      "the seeded peer survived the rejected confirmation",
    );

    // A malformed PUT body still fails loudly instead of silently defaulting.
    const malformed = await call("legacy-operator", "/engram/v1/peers/malformed-peer", {
      method: "PUT",
      body: JSON.stringify({ displayName: 5 }),
    });
    assert.equal(malformed.status, 400, "a non-string displayName is rejected");
    assert.match(await malformed.text(), /displayName/);
    assert.ok(
      !(await snapshotDir(root)).some((line) => line.startsWith("peers/malformed-peer/")),
      "the rejected write created no peer file",
    );
  } finally {
    await server.stop();
    await cleanup();
  }
});
