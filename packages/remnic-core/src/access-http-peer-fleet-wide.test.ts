import assert from "node:assert/strict";
import test from "node:test";

import { EngramAccessHttpServer } from "./access-http.js";
import type { EngramAccessService } from "./access-service.js";
import { parseConfig } from "./config.js";

// Issue #3225 B3: the HTTP peer routes dispatch to global stores, so REST
// must enforce the same operation policy as MCP — a namespace-scoped token
// (any namespaces axis, including []) must be denied before the service is
// reached, while ops-scoped and legacy tokens keep working.

interface PeerCallLog {
  list: number;
  get: string[];
  set: string[];
  delete: string[];
  forget: string[];
  profile: string[];
}

function makeLoggingService(log: PeerCallLog): EngramAccessService {
  const service = {
    configRef: parseConfig({
      memoryDir: "/tmp/remnic-http-peer-fleet-wide",
      namespacesEnabled: false,
      defaultNamespace: "global",
    }),
    peerList: async () => {
      log.list += 1;
      return { peers: [] };
    },
    peerGet: async (peerId: string) => {
      log.get.push(peerId);
      return {
        found: true,
        peer: { id: peerId, kind: "agent", displayName: peerId, createdAt: "2026-11-11T00:00:00.000Z", updatedAt: "2026-11-11T00:00:00.000Z" },
      };
    },
    peerSet: async (input: { id: string; displayName?: string }) => {
      log.set.push(input.id);
      return {
        ok: true,
        created: true,
        peer: { id: input.id, kind: "agent", displayName: input.displayName ?? input.id, createdAt: "2026-11-11T00:00:00.000Z", updatedAt: "2026-11-11T00:00:00.000Z" },
      };
    },
    peerDelete: async (peerId: string) => {
      log.delete.push(peerId);
      return { ok: true, deleted: true };
    },
    peerForget: async (peerId: string) => {
      log.forget.push(peerId);
      return { ok: true, purged: true };
    },
    peerProfileGet: async (peerId: string) => {
      log.profile.push(peerId);
      return { found: false };
    },
  };
  // SAFETY: the peer routes under test only touch configRef and the six peer
  // methods stubbed above; no other EngramAccessService member is reachable
  // from these paths.
  return service as unknown as EngramAccessService;
}

function emptyLog(): PeerCallLog {
  return { list: 0, get: [], set: [], delete: [], forget: [], profile: [] };
}

test("HTTP peer routes deny namespace-scoped tokens before the service, REST policy matches MCP (issue #3225 B3)", async () => {
  const log = emptyLog();
  const server = new EngramAccessHttpServer({
    service: makeLoggingService(log),
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
    // Namespace-scoped token (single namespace): every peer route is denied
    // BEFORE the service method runs — including the destructive purge.
    assert.equal((await call("ns-scoped", "/engram/v1/peers")).status, 403, "peer_list denied");
    assert.equal((await call("ns-scoped", "/engram/v1/peers/b3-p")).status, 403, "peer_get denied");
    assert.equal(
      (await call("ns-scoped", "/engram/v1/peers/b3-p", { method: "PUT", body: JSON.stringify({ displayName: "hijack" }) })).status,
      403,
      "peer_set denied",
    );
    assert.equal((await call("ns-scoped", "/engram/v1/peers/b3-p", { method: "DELETE" })).status, 403, "peer_delete denied");
    assert.equal(
      (
        await call("ns-scoped", "/engram/v1/peers/b3-p?forget=true", {
          method: "DELETE",
          body: JSON.stringify({ confirm: "yes" }),
        })
      ).status,
      403,
      "peer_forget denied",
    );
    assert.equal((await call("ns-scoped", "/engram/v1/peers/b3-p/profile")).status, 403, "peer_profile_get denied");

    // Empty namespace allow-list: denied too.
    assert.equal((await call("ns-empty", "/engram/v1/peers")).status, 403, "empty namespace list denied");

    // Denials never reached the service — no read, no mutation.
    assert.deepEqual(
      log,
      emptyLog(),
      "denied requests must not call any peer service method",
    );

    // An ops-scoped token without a namespace axis keeps full peer access.
    const listed = await call("ops-peer", "/engram/v1/peers");
    assert.equal(listed.status, 200, "ops-scoped token lists peers");
    await listed.text();
    const created = await call("ops-peer", "/engram/v1/peers/ops-peer-1", {
      method: "PUT",
      body: JSON.stringify({ displayName: "ops token peer" }),
    });
    assert.equal(created.status, 201, "ops-scoped token registers a peer");
    await created.text();
    const purged = await call("ops-peer", "/engram/v1/peers/ops-peer-1?forget=true", {
      method: "DELETE",
      body: JSON.stringify({ confirm: "yes" }),
    });
    assert.equal(purged.status, 200, "ops-scoped token purges a peer");
    await purged.text();
    assert.equal(log.set.includes("ops-peer-1"), true, "peer_set ran for the ops-scoped token");
    assert.equal(log.forget.includes("ops-peer-1"), true, "peer_forget ran for the ops-scoped token");

    // Legacy unrestricted token (static authToken, no capability record).
    const legacyList = await call("legacy-operator", "/engram/v1/peers");
    assert.equal(legacyList.status, 200, "legacy token lists peers");
    await legacyList.text();

    // Peer-forget confirmation behavior is unchanged: no confirm body, no purge.
    const unconfirmed = await call("legacy-operator", "/engram/v1/peers/b3-p?forget=true", {
      method: "DELETE",
      body: JSON.stringify({}),
    });
    assert.equal(unconfirmed.status, 400, "missing confirm still fails with 400");
    const unconfirmedBody = (await unconfirmed.json()) as { code?: string };
    assert.equal(unconfirmedBody.code, "confirm_required");
    assert.equal(log.forget.length, 1, "peerForget ran only for the confirmed purge");
  } finally {
    await server.stop();
  }
});
