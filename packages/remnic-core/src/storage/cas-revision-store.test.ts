import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CasRevisionStore } from "./cas-revision-store.js";

async function withStore(run: (store: CasRevisionStore, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-cas-store-"));
  try {
    await run(new CasRevisionStore(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function shardPathFor(root: string, target: string): string {
  const relative = path.relative(root, target).split(path.sep).join("/");
  const hash = createHash("sha256").update(relative).digest("hex");
  return path.join(root, ".offline-sync", "cas-revisions", `${hash}.json`);
}

test("a second reservation refuses while a pending transaction stands; abort restores the standing token (#2813 P1 C)", async () => {
  await withStore(async (store, root) => {
    const target = path.join(root, "memories", "fact-a.md");

    const a = await store.beginRevisionTransaction(target);
    assert.equal((await store.readRevisionStatus(target)).status, "unavailable", "pending is never ownership");
    await a.commit();
    assert.deepEqual(await store.readRevisionStatus(target), {
      status: "present",
      revision: a.pendingRevision,
    });

    // Writer B reserves while the shard holds a standing committed token.
    const b = await store.beginRevisionTransaction(target);
    assert.ok(b.pendingRevision > a.pendingRevision, "the reserved token exceeds the standing token");
    // Writer C cannot reserve while B's PENDING marker stands — concurrent
    // ownership is impossible: the ambiguity refuses the new transaction.
    await assert.rejects(store.beginRevisionTransaction(target), /pending finalization/);
    assert.equal(
      (await store.readRevisionStatus(target)).status,
      "unavailable",
      "readers see recovery-needed, never B's pending token and never absence",
    );

    // B's memory write failed: the abort restores A's standing token.
    await b.abort();
    assert.deepEqual(await store.readRevisionStatus(target), {
      status: "present",
      revision: a.pendingRevision,
    });

    // The next reservation still exceeds the standing committed token.
    const c = await store.beginRevisionTransaction(target);
    assert.ok(c.pendingRevision > a.pendingRevision);
    await c.commit();
    assert.deepEqual(await store.readRevisionStatus(target), {
      status: "present",
      revision: c.pendingRevision,
    });
    assert.notEqual(a.pendingRevision, c.pendingRevision, "two owned commits never share a receipt");
  });
});

test("reconcilePendingRevision publishes or discards with the known write outcome (#2813 P1 C)", async () => {
  await withStore(async (store, root) => {
    const target = path.join(root, "memories", "fact-b.md");
    assert.equal(await store.reconcilePendingRevision(target, true), "absent", "no shard is a no-op");

    const a = await store.beginRevisionTransaction(target);
    await a.commit();
    assert.equal(await store.reconcilePendingRevision(target, true), "committed", "an already-committed shard is untouched");

    // A crashed transaction whose memory write LANDED: the pending token
    // publishes as the standing receipt.
    const b = await store.beginRevisionTransaction(target);
    assert.equal(await store.reconcilePendingRevision(target, true), "reconciled");
    assert.deepEqual(await store.readRevisionStatus(target), {
      status: "present",
      revision: b.pendingRevision,
    });

    // A crashed transaction whose memory write did NOT land: the previous
    // standing token is restored.
    const c = await store.beginRevisionTransaction(target);
    assert.equal(await store.reconcilePendingRevision(target, false), "reconciled");
    assert.deepEqual(await store.readRevisionStatus(target), {
      status: "present",
      revision: b.pendingRevision,
    });

    // From a fresh target (no standing token), a discarded reservation
    // returns the shard to genuine absence.
    const fresh = path.join(root, "memories", "fact-c.md");
    const d = await store.beginRevisionTransaction(fresh);
    assert.equal(await store.reconcilePendingRevision(fresh, false), "reconciled");
    assert.equal((await store.readRevisionStatus(fresh)).status, "absent");
    assert.equal(
      await readFile(path.join(root, "memories", "fact-c.md"), "utf8").then(
        () => true,
        () => false,
      ),
      false,
      "sanity: the store never touches the memory file itself",
    );
    assert.ok(d.pendingRevision.length > 0);
  });
});

test("a pre-two-phase shard without state reads as committed and mints forward (#2813 P1 C)", async () => {
  await withStore(async (store, root) => {
    const target = path.join(root, "memories", "fact-legacy.md");
    const relative = path.relative(root, target).split(path.sep).join("/");
    const legacyToken = "2026-08-01T00:00:00.000Z";
    await mkdir(path.dirname(shardPathFor(root, target)), { recursive: true });
    await writeFile(
      shardPathFor(root, target),
      `${JSON.stringify({ version: 1, path: relative, revision: legacyToken })}\n`,
      "utf8",
    );
    assert.deepEqual(await store.readRevisionStatus(target), { status: "present", revision: legacyToken });

    const next = await store.beginRevisionTransaction(target);
    assert.ok(next.pendingRevision > legacyToken);
    await next.commit();
    const shard = JSON.parse(await readFile(shardPathFor(root, target), "utf8")) as {
      state?: string;
      revision?: string;
    };
    assert.equal(shard.state, "committed");
    assert.equal(shard.revision, next.pendingRevision);
  });
});

test("a symlinked cas-revisions directory is rejected at the store boundary (#2813 P1 A)", async () => {
  await withStore(async (store, root) => {
    const target = path.join(root, "memories", "fact-guard.md");
    const a = await store.beginRevisionTransaction(target);
    await a.commit();

    const escapeRoot = await mkdtemp(path.join(os.tmpdir(), "remnic-cas-store-escape-"));
    try {
      const shardDir = path.join(root, ".offline-sync", "cas-revisions");
      await rm(shardDir, { recursive: true, force: true });
      await symlink(escapeRoot, shardDir);

      const status = await store.readRevisionStatus(target);
      assert.equal(status.status, "unavailable", "the symlinked sidecar is never read through");
      await assert.rejects(store.beginRevisionTransaction(target));
      await assert.rejects(store.reconcilePendingRevision(target, true));
      assert.deepEqual(await readdir(escapeRoot), [], "no lock, shard, or temp file escaped the root");
    } finally {
      await rm(escapeRoot, { recursive: true, force: true });
    }
  });
});

test("a corrupt state-bearing shard is unavailability, never absence (#2813 P1 C)", async () => {
  await withStore(async (store, root) => {
    const target = path.join(root, "memories", "fact-corrupt.md");
    await mkdir(path.dirname(shardPathFor(root, target)), { recursive: true });
    await writeFile(
      shardPathFor(root, target),
      `${JSON.stringify({ version: 1, path: "x", revision: "2026-08-01T00:00:00.000Z", state: "bogus" })}\n`,
      "utf8",
    );
    const status = await store.readRevisionStatus(target);
    assert.equal(status.status, "unavailable");
    await assert.rejects(store.beginRevisionTransaction(target), /unreadable/);
  });
});
