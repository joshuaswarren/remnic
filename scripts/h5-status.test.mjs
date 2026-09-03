import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { h5Status } from "./h5-status.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "h5-status-"));
  await writeFile(path.join(root, "run.json"), `${JSON.stringify({ limit: 1 })}\n`);
  return root;
}

async function checkpoint(root, value) {
  const dir = path.join(root, "checkpoints");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "row.json"), `${JSON.stringify(value)}\n`);
}

test("reports fresh empty run as RUNNING", async () => {
  const root = await fixture();
  try {
    assert.equal((await h5Status(root)).state, "RUNNING");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects expected-design drift in run metadata", async () => {
  const root = await fixture();
  try {
    await writeFile(path.join(root, "run.json"), `${JSON.stringify({ limit: 1, expectedRows: 2 })}\n`);
    await assert.rejects(() => h5Status(root), /expectedRows/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the frozen design outranks the metadata grid formula", async () => {
  const root = await fixture();
  try {
    // A single-arm run: the formula would say 4 rows; the design says 1.
    await writeFile(path.join(root, "run.json"), `${JSON.stringify({
      seeds: [71],
      variantsPerFamily: 1,
      family: "minja",
      expectedRows: 1,
    })}\n`);
    await writeFile(path.join(root, "expected-design.json"), `${JSON.stringify({ rows: [{ rowKey: "row" }] })}\n`);
    assert.equal((await h5Status(root)).expectedRows, 1);
    // Drift between run.json and the design is refused.
    await writeFile(path.join(root, "expected-design.json"), `${JSON.stringify({ rows: [{ rowKey: "a" }, { rowKey: "b" }] })}\n`);
    await assert.rejects(() => h5Status(root), /expectedRows/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("online rows with a durably rejected rewrite count as completed", async () => {
  const root = await fixture();
  try {
    await writeFile(path.join(root, "run.json"), `${JSON.stringify({ stage: "adaptive-online-r1", expectedRows: 1 })}\n`);
    await writeFile(path.join(root, "expected-design.json"), `${JSON.stringify({
      rows: [{ rowKey: "row", identity: { arm: "source-authenticated-fencing", variantId: "adaptive-online-r1-minja-1-k1" } }],
    })}\n`);
    await writeFile(path.join(root, "online-corpus.jsonl"), `${JSON.stringify({
      arm: "source-authenticated-fencing", variantId: "adaptive-online-r1-minja-1-k1", iteration: 1, valid: false,
    })}\n`);
    const status = await h5Status(root);
    assert.equal(status.state, "COMPLETE");
    assert.equal(status.rejectedRewriteRows, 1);
    assert.equal(status.remainingRows, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("byte-identical re-appended episode rows are one row; conflicting repeats are malformed", async () => {
  const root = await fixture();
  try {
    await checkpoint(root, { tries: [], terminal: { rowKey: "row" } });
    await writeFile(path.join(root, "episodes.jsonl"), '{"rowKey":"row","fenced":true}\n{"rowKey":"row","fenced":true}\n');
    assert.equal((await h5Status(root)).state, "COMPLETE");
    await writeFile(path.join(root, "episodes.jsonl"), '{"rowKey":"row","fenced":true}\n{"rowKey":"row","fenced":false}\n');
    const conflicting = await h5Status(root);
    assert.equal(conflicting.state, "MALFORMED");
    assert.ok(conflicting.errors.includes("duplicate episode rowKey"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("counts one family for targeted calibration runs", async () => {
  const root = await fixture();
  try {
    await writeFile(path.join(root, "run.json"), `${JSON.stringify({
      seeds: [71],
      variantsPerFamily: 10,
      family: "sleeper",
      expectedRows: 40,
    })}\n`);
    assert.equal((await h5Status(root)).expectedRows, 40);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports matching terminal checkpoint and episode as COMPLETE", async () => {
  const root = await fixture();
  try {
    await checkpoint(root, { tries: [], terminal: { rowKey: "row" } });
    await writeFile(path.join(root, "episodes.jsonl"), '{"rowKey":"row"}\n');
    const status = await h5Status(root);
    assert.equal(status.state, "COMPLETE");
    assert.equal(status.remainingRows, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports terminal checkpoint awaiting episode repair as PAUSED", async () => {
  const root = await fixture();
  try {
    await checkpoint(root, { tries: [], terminal: { rowKey: "row" } });
    const status = await h5Status(root);
    assert.equal(status.state, "PAUSED");
    assert.equal(status.recoveryRows, 1);
    assert.deepEqual(status.errors, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports an ambiguous paid request as PAUSED", async () => {
  const root = await fixture();
  try {
    await checkpoint(root, {
      tries: [],
      inFlight: { attempt: 1, startedAt: "2026-08-27T00:00:00.000Z" },
    });
    const status = await h5Status(root);
    assert.equal(status.state, "PAUSED");
    assert.equal(status.ambiguousRows, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps a freshly claimed in-flight request RUNNING", async () => {
  const root = await fixture();
  try {
    await checkpoint(root, {
      rowKey: "row",
      tries: [],
      inFlight: { attempt: 1, startedAt: "2026-08-27T00:00:00.000Z" },
    });
    await mkdir(path.join(root, "checkpoints", "row.lock"));
    const status = await h5Status(root);
    assert.equal(status.state, "RUNNING");
    assert.equal(status.activeClaims, 1);
    assert.equal(status.inFlightRows, 1);
    assert.equal(status.ambiguousRows, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports six trailing host faults as PAUSED", async () => {
  const root = await fixture();
  try {
    await checkpoint(root, {
      tries: Array.from({ length: 6 }, () => ({ outcome: { kind: "HOST_API_FAULT" } })),
    });
    const status = await h5Status(root);
    assert.equal(status.state, "PAUSED");
    assert.equal(status.hostFaultTries, 6);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("treats a lock with a recent owner.json heartbeat as an active claim", async () => {
  const root = await fixture();
  try {
    await checkpoint(root, { tries: [] });
    const lockDir = path.join(root, "checkpoints", "row.lock");
    await mkdir(lockDir, { recursive: true });
    await writeFile(path.join(lockDir, "owner.json"), `{}\n`);
    const status = await h5Status(root);
    assert.equal(status.activeClaims, 1);
    assert.equal(status.staleClaims, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adapts expectedRows to the adaptive two-arm grid for adaptive-r1", async () => {
  const root = await fixture();
  try {
    await writeFile(
      path.join(root, "run.json"),
      `${JSON.stringify({
        seeds: [71],
        variantsPerFamily: 100,
        stage: "adaptive-r1",
        expectedRows: 800,
      })}\n`,
    );
    assert.equal((await h5Status(root)).expectedRows, 800);
    // Without a frozen design the grid formula is the fallback only when
    // run.json carries no expectedRows.
    await writeFile(
      path.join(root, "run.json"),
      `${JSON.stringify({ seeds: [71], variantsPerFamily: 100, stage: "adaptive-r1" })}\n`,
    );
    assert.equal((await h5Status(root)).expectedRows, 800);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ignores a claim lock removed between readdir and stat", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "h5-status-"));
  try {
    await writeFile(path.join(root, "run.json"), `${JSON.stringify({ limit: 1 })}\n`);
    const dir = path.join(root, "checkpoints");
    const lockPath = path.join(dir, "row.lock");
    await mkdir(lockPath, { recursive: true });
    let removed = false;
    const statImpl = async (target, opts) => {
      if (!removed && target === lockPath) {
        removed = true;
        await rm(lockPath, { recursive: true, force: true });
      }
      return stat(target, opts);
    };
    const status = await h5Status(root, 20, statImpl);
    assert.equal(removed, true, "stat seam should have fired before the second loop");
    assert.deepEqual(status.errors, []);
    assert.equal(status.activeClaims, 0);
    assert.equal(status.staleClaims, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
