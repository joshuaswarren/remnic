import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EngramAccessHttpServer } from "../access-http.js";
import { EngramAccessInputError, type EngramAccessService } from "../access-service.js";
import type { StorageManager } from "../storage.js";
import { RELAY_DEMO_MISSION_ID, RELAY_DEMO_NAMESPACE, createRelayMissionFixture } from "./mission-fixture.js";
import type { RelayMissionSnapshot } from "./mission.js";

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-relay-http-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fakeService(
  root: string,
  calls: Array<{ mode: "read" | "write"; namespace?: string; principal?: string }>
): EngramAccessService {
  const storage = { dir: root } as StorageManager;
  return {
    configRef: {
      defaultNamespace: RELAY_DEMO_NAMESPACE,
      namespacesEnabled: true,
    },
    getReadableStorageForNamespace: async (namespace?: string, principal?: string) => {
      if (namespace === "forbidden") throw new EngramAccessInputError("namespace is not readable");
      calls.push({ mode: "read", namespace, principal });
      return { namespace: namespace ?? RELAY_DEMO_NAMESPACE, storage };
    },
    getWritableStorageForNamespace: async (namespace?: string, principal?: string) => {
      if (namespace === "forbidden") throw new EngramAccessInputError("namespace is not writable");
      calls.push({ mode: "write", namespace, principal });
      return { namespace: namespace ?? RELAY_DEMO_NAMESPACE, storage };
    },
  } as unknown as EngramAccessService;
}

function authHeaders(token = "relay-token"): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

test("HTTP fixture endpoint returns one complete, namespace-authorized Relay receipt", async () => {
  await withTempRoot(async (root) => {
    const calls: Array<{
      mode: "read" | "write";
      namespace?: string;
      principal?: string;
    }> = [];
    const server = new EngramAccessHttpServer({
      service: fakeService(root, calls),
      port: 0,
      authToken: "relay-token",
      principal: "operator-build-week",
      adminConsoleEnabled: false,
    });
    const status = await server.start();
    const base = `http://127.0.0.1:${status.port}/engram/v1/relay/missions/${RELAY_DEMO_MISSION_ID}`;
    try {
      const fixture = createRelayMissionFixture();
      const approval = fixture.find((event) => event.payload.kind === "correction_approved");
      assert.ok(approval && approval.payload.kind === "correction_approved");
      const mismatchedApproval = await fetch(`${base}/events`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          namespace: RELAY_DEMO_NAMESPACE,
          event: {
            ...approval,
            idempotencyKey: "mismatched-human-approval",
            payload: {
              ...approval.payload,
              approvedBy: { ...approval.payload.approvedBy, id: "different-operator" },
            },
          },
        }),
      });
      assert.equal(mismatchedApproval.status, 400);
      assert.equal(((await mismatchedApproval.json()) as { code: string }).code, "input_error");

      const blankNamespace = await fetch(`${base}/events`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ namespace: "", event: fixture[0] }),
      });
      assert.equal(blankNamespace.status, 400);

      const flatBody = await fetch(`${base}/events`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(fixture[0]),
      });
      assert.equal(flatBody.status, 400);

      for (const input of fixture) {
        const response = await fetch(`${base}/events`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ namespace: RELAY_DEMO_NAMESPACE, event: input }),
        });
        const responseBody = await response.text();
        assert.equal(response.status, 201, responseBody);
        assert.equal(
          (JSON.parse(responseBody) as { event: { authenticatedPrincipal?: string } }).event.authenticatedPrincipal,
          "operator-build-week"
        );
      }

      const replay = await fetch(`${base}/events`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ namespace: RELAY_DEMO_NAMESPACE, event: fixture[0] }),
      });
      assert.equal(replay.status, 200);
      assert.equal(((await replay.json()) as { replayed: boolean }).replayed, true);

      const response = await fetch(`${base}?namespace=${RELAY_DEMO_NAMESPACE}&limit=20`, {
        headers: authHeaders(),
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-remnic-authenticated-principal"), "operator-build-week");
      const snapshot = (await response.json()) as RelayMissionSnapshot;
      assert.equal(snapshot.receipt.complete, true);
      assert.deepEqual(snapshot.receipt.activeDecisionIds, ["decision-refresh-after-expiry"]);
      assert.deepEqual(snapshot.receipt.supersededDecisionIds, ["decision-new-token-every-request"]);
      assert.equal(snapshot.agents.length, 3);
      assert.equal(snapshot.tests.at(-1)?.status, "passed");
      assert.ok(calls.every((call) => call.namespace === RELAY_DEMO_NAMESPACE));
      assert.ok(calls.every((call) => call.principal === "operator-build-week"));
    } finally {
      await server.stop();
    }
  });
});

test("HTTP Relay rejects human approval without a server-resolved principal before persistence", async () => {
  await withTempRoot(async (root) => {
    const server = new EngramAccessHttpServer({
      service: fakeService(root, []),
      port: 0,
      authToken: "relay-token",
      adminConsoleEnabled: false,
    });
    const status = await server.start();
    const base = `http://127.0.0.1:${status.port}/engram/v1/relay/missions/${RELAY_DEMO_MISSION_ID}`;
    try {
      const approval = createRelayMissionFixture().find((event) => event.payload.kind === "correction_approved");
      assert.ok(approval);
      const rejected = await fetch(`${base}/events`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ namespace: RELAY_DEMO_NAMESPACE, event: approval }),
      });
      assert.equal(rejected.status, 400);
      assert.equal(((await rejected.json()) as { code: string }).code, "input_error");

      const snapshotResponse = await fetch(`${base}?namespace=${RELAY_DEMO_NAMESPACE}`, {
        headers: authHeaders(),
      });
      assert.equal(snapshotResponse.status, 200);
      assert.equal(snapshotResponse.headers.get("x-remnic-authenticated-principal"), null);
      assert.equal(((await snapshotResponse.json()) as RelayMissionSnapshot).found, false);
    } finally {
      await server.stop();
    }
  });
});

test("HTTP Relay surface distinguishes empty, invalid, unauthorized, and backend-failed reads", async () => {
  await withTempRoot(async (root) => {
    const service = fakeService(root, []);
    const server = new EngramAccessHttpServer({
      service,
      port: 0,
      authTokenEntriesGetter: () => [
        {
          token: "read-token",
          connector: "codex",
          capabilities: {
            version: 1,
            ops: ["relay_mission_read"],
            namespaces: [RELAY_DEMO_NAMESPACE],
          },
        },
      ],
      adminConsoleEnabled: false,
    });
    const status = await server.start();
    const origin = `http://127.0.0.1:${status.port}`;
    const emptyUrl = `${origin}/engram/v1/relay/missions/empty-mission?namespace=${RELAY_DEMO_NAMESPACE}`;
    try {
      const unauthenticated = await fetch(emptyUrl);
      assert.equal(unauthenticated.status, 401);

      const empty = await fetch(emptyUrl, { headers: authHeaders("read-token") });
      assert.equal(empty.status, 200);
      assert.equal(empty.headers.get("x-remnic-authenticated-principal"), null);
      assert.deepEqual(await empty.json(), assertEmptyMissionShape());

      const badLimit = await fetch(`${emptyUrl}&limit=501`, {
        headers: authHeaders("read-token"),
      });
      assert.equal(badLimit.status, 400);

      const blankNamespace = await fetch(`${origin}/engram/v1/relay/missions/empty-mission?namespace=`, {
        headers: authHeaders("read-token"),
      });
      assert.equal(blankNamespace.status, 400);

      const badSince = await fetch(`${emptyUrl}&since=${encodeURIComponent("2026-01-01T00:00:00+99:99")}`, {
        headers: authHeaders("read-token"),
      });
      assert.equal(badSince.status, 400);

      const traversal = await fetch(
        `${origin}/engram/v1/relay/missions/%2E%2Eproduction?namespace=${RELAY_DEMO_NAMESPACE}`,
        {
          headers: authHeaders("read-token"),
        }
      );
      assert.equal(traversal.status, 400);

      const wrongNamespace = await fetch(`${origin}/engram/v1/relay/missions/empty-mission?namespace=forbidden`, {
        headers: authHeaders("read-token"),
      });
      assert.equal(wrongNamespace.status, 403);

      const deniedWrite = await fetch(`${origin}/engram/v1/relay/missions/${RELAY_DEMO_MISSION_ID}/events`, {
        method: "POST",
        headers: authHeaders("read-token"),
        body: JSON.stringify({
          namespace: RELAY_DEMO_NAMESPACE,
          event: createRelayMissionFixture()[0],
        }),
      });
      assert.equal(deniedWrite.status, 403);
    } finally {
      await server.stop();
    }
  });

  await withTempRoot(async (root) => {
    const missingRoot = path.join(root, "missing-storage-root");
    const server = new EngramAccessHttpServer({
      service: fakeService(missingRoot, []),
      port: 0,
      authToken: "relay-token",
      adminConsoleEnabled: false,
    });
    const status = await server.start();
    try {
      const response = await fetch(`http://127.0.0.1:${status.port}/engram/v1/relay/missions/backend-failure`, {
        headers: authHeaders(),
      });
      assert.equal(response.status, 500);
      assert.equal(((await response.json()) as { code: string }).code, "relay_unsafe_path");
    } finally {
      await server.stop();
    }
  });
});

test("HTTP Relay write quota is charged only for a real append, never an idempotent replay", async () => {
  await withTempRoot(async (root) => {
    const server = new EngramAccessHttpServer({
      service: fakeService(root, []),
      port: 0,
      authToken: "relay-token",
      adminConsoleEnabled: false,
      writeRateLimitMaxRequests: 1,
      writeRateLimitWindowMs: 60_000,
    });
    const status = await server.start();
    const url = `http://127.0.0.1:${status.port}/engram/v1/relay/missions/${RELAY_DEMO_MISSION_ID}/events`;
    const fixture = createRelayMissionFixture();
    try {
      const first = await fetch(url, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ event: fixture[0] }),
      });
      assert.equal(first.status, 201);

      const replay = await fetch(url, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ event: fixture[0] }),
      });
      assert.equal(replay.status, 200);
      assert.equal(((await replay.json()) as { replayed: boolean }).replayed, true);

      const secondEvent = await fetch(url, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ event: fixture[1] }),
      });
      assert.equal(secondEvent.status, 429);
      assert.equal(((await secondEvent.json()) as { code: string }).code, "write_rate_limited");
    } finally {
      await server.stop();
    }
  });
});

test("HTTP Relay reserves global write quota across concurrent mission appends", async () => {
  await withTempRoot(async (root) => {
    const server = new EngramAccessHttpServer({
      service: fakeService(root, []),
      port: 0,
      authToken: "relay-token",
      adminConsoleEnabled: false,
      writeRateLimitMaxRequests: 1,
      writeRateLimitWindowMs: 60_000,
    });
    const status = await server.start();
    const missionIds = ["concurrent-mission-a", "concurrent-mission-b"];
    const startEvent = createRelayMissionFixture()[0];
    assert.ok(startEvent);
    const urls = missionIds.map(
      (missionId) => `http://127.0.0.1:${status.port}/engram/v1/relay/missions/${missionId}/events`
    );
    try {
      const responses = await Promise.all(
        urls.map((url) =>
          fetch(url, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ event: startEvent }),
          })
        )
      );
      assert.deepEqual(
        responses.map((response) => response.status).sort((a, b) => a - b),
        [201, 429]
      );

      const winnerIndex = responses.findIndex((response) => response.status === 201);
      assert.notEqual(winnerIndex, -1);
      const replay = await fetch(urls[winnerIndex] ?? "", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ event: startEvent }),
      });
      assert.equal(replay.status, 200);
      assert.equal(((await replay.json()) as { replayed: boolean }).replayed, true);
    } finally {
      await server.stop();
    }
  });
});

test("Relay write quota releases the exact reservation when timestamps collide", () => {
  const server = new EngramAccessHttpServer({
    service: {} as EngramAccessService,
    port: 0,
    authToken: "relay-token",
    adminConsoleEnabled: false,
  });
  const internals = server as unknown as {
    writeRequestSlots: Array<{ readonly recordedAt: number }>;
    reserveWriteRateLimitSlot: () => () => void;
  };
  const originalNow = Date.now;
  try {
    Date.now = () => 1_754_000_000_000;
    const releaseCommitted = internals.reserveWriteRateLimitSlot();
    const committedSlot = internals.writeRequestSlots[0];
    const releaseFailed = internals.reserveWriteRateLimitSlot();
    const failedSlot = internals.writeRequestSlots[1];
    assert.ok(committedSlot);
    assert.ok(failedSlot);
    assert.notEqual(committedSlot, failedSlot);

    releaseFailed();
    assert.deepEqual(internals.writeRequestSlots, [committedSlot]);

    releaseCommitted();
    assert.deepEqual(internals.writeRequestSlots, []);
  } finally {
    Date.now = originalNow;
  }
});

function assertEmptyMissionShape(): RelayMissionSnapshot {
  return {
    schemaVersion: "1",
    missionId: "empty-mission",
    namespace: RELAY_DEMO_NAMESPACE,
    found: false,
    readHealth: "empty",
    status: "not_started",
    mission: {
      title: null,
      objective: null,
      runMode: null,
      startedAt: null,
      completedAt: null,
    },
    agents: [],
    decisions: [],
    conflicts: [],
    corrections: [],
    tests: [],
    propagation: [],
    outcome: null,
    receipt: {
      complete: false,
      missingEvidence: [],
      activeDecisionIds: [],
      supersededDecisionIds: [],
      coldStartVerified: false,
      passingOutcomeVerified: false,
    },
    bounds: {
      totalEvents: 0,
      returnedEvents: 0,
      corruptLines: 0,
      truncated: false,
      since: null,
      until: null,
    },
    events: [],
  };
}
