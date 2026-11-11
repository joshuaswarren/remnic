import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import "./access-operations-batch.js"; // registration side effect: the real operations
import { getOperation } from "./access-boundary.js";
import { EngramAccessService } from "./access-service.js";
import { EngramAccessForbiddenError } from "./access-errors.js";
import { tokenCapabilityStore, type TokenCapabilities } from "./access-token-capabilities.js";
import { Orchestrator } from "./orchestrator.js";
import { parseConfig } from "./config.js";
import { writePeer, writePeerProfile } from "./peers/index.js";
import { WorkStorage } from "./work/storage.js";

// Issue #3225 B3: work_task / work_project / work_board and the six peer
// operations run against GLOBAL stores, so a namespace argument cannot
// isolate them. They must carry fleetWide: true like the other cross-fleet
// operations, and the HTTP peer routes must enforce the same policy.

const PEER_ID = "b3-target-peer";
const NOW = "2026-11-11T00:00:00.000Z";

/** The nine operations that touch a global store (issue #3225 B3). */
const GLOBAL_OPS = [
  "work_task",
  "work_project",
  "work_board",
  "peer_list",
  "peer_get",
  "peer_set",
  "peer_delete",
  "peer_profile_get",
  "peer_forget",
] as const;

interface Fixture {
  root: string;
  service: EngramAccessService;
  cleanup: () => Promise<void>;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-b3-fleet-wide-"));
  const orchestrator = new Orchestrator(
    parseConfig({ memoryDir: root, namespacesEnabled: false, defaultNamespace: "global" }),
  );
  const storage = await orchestrator.getStorage();
  await storage.ensureDirectories();
  const service = new EngramAccessService(orchestrator);
  return { root, service, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** Seed one synthetic record in each global store the nine operations touch. */
async function seedGlobalRecords(root: string): Promise<void> {
  const work = new WorkStorage(root);
  await work.ensureDirectories();
  await work.createTask({ title: "seeded task", description: "seeded" });
  await work.createProject({ name: "seeded project", description: "seeded" });
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

function runOp(
  name: (typeof GLOBAL_OPS)[number],
  input: Record<string, unknown>,
  service: EngramAccessService,
  capabilities?: TokenCapabilities,
): Promise<unknown> {
  const op = getOperation(name);
  assert.ok(op, `operation must be registered: ${name}`);
  const run = () => op.run(input, { service });
  return capabilities === undefined ? run() : tokenCapabilityStore.run(capabilities, run);
}

test("B3: a one-namespace token is denied on every global work and peer op BEFORE any read or mutation", async () => {
  const fixture = await createFixture();
  try {
    await seedGlobalRecords(fixture.root);
    const before = await snapshotDir(fixture.root);

    const MUTATING_INPUT: Record<(typeof GLOBAL_OPS)[number], Record<string, unknown>> = {
      work_task: { action: "create", title: "intruder task" },
      work_project: { action: "create", name: "intruder project" },
      work_board: { action: "import_snapshot", projectId: "proj-x", snapshotJson: "{}" },
      peer_list: {},
      peer_get: { id: PEER_ID },
      peer_set: { id: PEER_ID, displayName: "hijacked" },
      peer_delete: { id: PEER_ID },
      peer_profile_get: { id: PEER_ID },
      peer_forget: { id: PEER_ID, confirm: "yes" },
    };

    for (const namespaces of [["ns_a"], []]) {
      const caps: TokenCapabilities = { version: 1, namespaces };
      for (const name of GLOBAL_OPS) {
        await assert.rejects(
          () => runOp(name, MUTATING_INPUT[name], fixture.service, caps),
          (err: unknown) =>
            err instanceof EngramAccessForbiddenError && /scoped to specific namespaces/.test(err.message),
          `${name} must reject a token restricted to ${JSON.stringify(namespaces)}`,
        );
      }
    }

    const after = await snapshotDir(fixture.root);
    assert.deepEqual(after, before, "denials must not change any file in any global store");
  } finally {
    await fixture.cleanup();
  }
});

test("B3: an ops-scoped token without a namespace axis may use its permitted global ops", async () => {
  const fixture = await createFixture();
  try {
    const caps: TokenCapabilities = { version: 1, ops: [...GLOBAL_OPS] };

    const created = (await runOp("work_task", { action: "create", title: "ops token task" }, fixture.service, caps)) as {
      result: { task: { id: string } };
    };
    assert.ok(created.result.task.id, "ops-scoped token creates a work task");

    const listed = (await runOp("work_task", { action: "list" }, fixture.service, caps)) as {
      result: { count: number };
    };
    assert.equal(listed.result.count, 1, "ops-scoped token reads its own created task");

    const peer = (await runOp("peer_set", { id: "ops-token-peer", kind: "agent" }, fixture.service, caps)) as {
      result: { created: boolean };
    };
    assert.equal(peer.result.created, true, "ops-scoped token registers a peer");

    const got = (await runOp("peer_get", { id: "ops-token-peer" }, fixture.service, caps)) as {
      result: { found: boolean };
    };
    assert.equal(got.result.found, true, "ops-scoped token reads a peer");

    const forgotten = (await runOp("peer_forget", { id: "ops-token-peer", confirm: "yes" }, fixture.service, caps)) as {
      result: { purged: boolean };
    };
    assert.equal(forgotten.result.purged, true, "ops-scoped token may run the destructive purge it is granted");
  } finally {
    await fixture.cleanup();
  }
});

test("B3: a legacy unrestricted token (no capability record) retains access to global ops", async () => {
  const fixture = await createFixture();
  try {
    await seedGlobalRecords(fixture.root);

    const listed = (await runOp("work_task", { action: "list" }, fixture.service)) as {
      result: { count: number };
    };
    assert.equal(listed.result.count, 1, "legacy token lists work tasks");

    const peers = (await runOp("peer_list", {}, fixture.service)) as {
      result: { peers: { id: string }[] };
    };
    assert.deepEqual(
      peers.result.peers.map((p) => p.id),
      [PEER_ID],
      "legacy token lists the seeded peer",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("B3: peer_forget confirmation requirement is unchanged through the boundary", async () => {
  const fixture = await createFixture();
  try {
    await seedGlobalRecords(fixture.root);
    await assert.rejects(
      () => runOp("peer_forget", { id: PEER_ID, confirm: "no" }, fixture.service),
      (err: unknown) => err instanceof Error && /confirm must be 'yes'/.test(err.message),
    );
    const files = await snapshotDir(fixture.root);
    assert.ok(files.some((line) => line.includes(`${PEER_ID}/identity.md`)), "peer survives a rejected confirmation");
  } finally {
    await fixture.cleanup();
  }
});


