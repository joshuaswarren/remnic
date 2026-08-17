import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ImportTurn } from "@remnic/core/bulk-import";
import {
  processOpenClawFlushPlanFile,
  reconcileOpenClawFlushPlanReplacementContent,
  resolveOpenClawFlushPlanPath,
} from "../src/openclaw-flush-plan-lifecycle.js";

const SERVICE_ID = "openclaw-remnic";

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function withWorkspace(
  fn: (workspaceDir: string, flushPlanPath: string) => Promise<void>,
): Promise<void> {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "remnic-flush-plan-"));
  const flushPlanPath = resolveOpenClawFlushPlanPath({
    workspaceDir,
    serviceId: SERVICE_ID,
  });
  try {
    await fn(workspaceDir, flushPlanPath);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function writeFlushPlan(flushPlanPath: string, content: string): Promise<void> {
  await mkdir(path.dirname(flushPlanPath), { recursive: true });
  await writeFile(flushPlanPath, content, "utf8");
}

function processedMarkerPath(flushPlanPath: string): string {
  return path.join(path.dirname(flushPlanPath), "flush-plan.processed.json");
}

test("reconcileOpenClawFlushPlanReplacementContent preserves tail before recreated bytes", () => {
  const preservedContent = "- Tail appended before cleanup.\n";
  const existingContent = "- Fresh note OpenClaw wrote after rotation.\n";

  assert.equal(
    reconcileOpenClawFlushPlanReplacementContent({
      existingContent,
      preservedContent,
    }),
    `${preservedContent}${existingContent}`,
  );
  assert.equal(
    reconcileOpenClawFlushPlanReplacementContent({
      existingContent: `${preservedContent}${existingContent}`,
      preservedContent,
    }),
    undefined,
  );
  assert.equal(
    reconcileOpenClawFlushPlanReplacementContent({
      existingContent: "",
      preservedContent: "",
    }),
    undefined,
  );
});

test("processOpenClawFlushPlanFile ingests and clears the flush-plan snapshot", async () => {
  await withWorkspace(async (workspaceDir, flushPlanPath) => {
    await writeFlushPlan(
      flushPlanPath,
      "- User prefers concise merge-status updates.\n",
    );
    const received: ImportTurn[][] = [];

    const result = await processOpenClawFlushPlanFile({
      enabled: true,
      workspaceDir,
      serviceId: SERVICE_ID,
      reason: "test",
      now: () => new Date("2026-06-24T00:00:00.000Z"),
      ingestor: {
        async ingestBulkImportBatch(turns) {
          received.push(turns);
        },
      },
    });

    assert.equal(result.status, "processed");
    assert.equal(await readFile(flushPlanPath, "utf8"), "");
    assert.equal(received.length, 1);
    assert.equal(received[0].length, 1);
    assert.equal(received[0][0].role, "user");
    assert.match(received[0][0].content, /concise merge-status updates/);
    assert.equal(
      received[0][0].importProvenance?.sourceLabel,
      "OpenClaw flush plan",
    );
    assert.equal(
      received[0][0].importProvenance?.importedFromPath,
      flushPlanPath,
    );
  });
});

test("processOpenClawFlushPlanFile writes markers through exclusive unguessable temp files", async () => {
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "remnic-marker-outside-"));
  try {
    await withWorkspace(async (workspaceDir, flushPlanPath) => {
      await writeFlushPlan(flushPlanPath, "- Marker temp paths must not follow symlinks.\n");
      const markerPath = processedMarkerPath(flushPlanPath);
      const legacyTempPath = `${markerPath}.${process.pid}.1234567890.tmp`;
      const outsidePath = path.join(outsideDir, "marker-target.json");
      await symlink(outsidePath, legacyTempPath);

      const originalDateNow = Date.now;
      Date.now = () => 1234567890;
      try {
        const result = await processOpenClawFlushPlanFile({
          enabled: true,
          workspaceDir,
          serviceId: SERVICE_ID,
          reason: "test-marker-temp-symlink",
          now: () => new Date("2026-06-24T00:00:00.000Z"),
          ingestor: {
            async ingestBulkImportBatch() {
              return undefined;
            },
          },
        });

        assert.equal(result.status, "processed");
      } finally {
        Date.now = originalDateNow;
      }

      await assert.rejects(readFile(outsidePath, "utf8"), /ENOENT/);
      assert.equal((await lstat(legacyTempPath)).isSymbolicLink(), true);
    });
  } finally {
    await rm(outsideDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("processOpenClawFlushPlanFile canonicalizes turn fingerprints across workspace aliases", async () => {
  const workspaceDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-flush-realpath-"),
  );
  const linkRoot = await mkdtemp(path.join(os.tmpdir(), "remnic-flush-link-"));
  const workspaceLink = path.join(linkRoot, "workspace");
  const flushPlanPath = resolveOpenClawFlushPlanPath({
    workspaceDir,
    serviceId: SERVICE_ID,
  });
  const linkFlushPlanPath = resolveOpenClawFlushPlanPath({
    workspaceDir: workspaceLink,
    serviceId: SERVICE_ID,
  });
  const content = "- Alias paths must not duplicate this flush-plan import.\n";
  const fingerprints: string[] = [];
  const provenancePaths: string[] = [];

  try {
    await symlink(workspaceDir, workspaceLink);
    const ingestor = {
      async ingestBulkImportBatch(turns: ImportTurn[]) {
        assert.equal(turns.length, 1);
        assert.equal(typeof turns[0]?.turnFingerprint, "string");
        fingerprints.push(turns[0]?.turnFingerprint ?? "");
        provenancePaths.push(turns[0]?.importProvenance?.importedFromPath ?? "");
      },
    };

    await writeFlushPlan(flushPlanPath, content);
    const first = await processOpenClawFlushPlanFile({
      enabled: true,
      workspaceDir: workspaceLink,
      serviceId: SERVICE_ID,
      ingestor,
    });
    assert.equal(first.status, "processed");

    await writeFlushPlan(flushPlanPath, content);
    const second = await processOpenClawFlushPlanFile({
      enabled: true,
      workspaceDir,
      serviceId: SERVICE_ID,
      ingestor,
    });
    assert.equal(second.status, "processed");

    assert.equal(fingerprints.length, 2);
    assert.equal(fingerprints[0], fingerprints[1]);
    assert.deepEqual(provenancePaths, [linkFlushPlanPath, flushPlanPath]);
  } finally {
    await rm(linkRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
    await rm(workspaceDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
});

test("processOpenClawFlushPlanFile preserves content appended during ingestion", async () => {
  await withWorkspace(async (workspaceDir, flushPlanPath) => {
    const original = "- Remember the release checklist.\n";
    const appended = "- Tail written by a later OpenClaw flush.\n";
    await writeFlushPlan(flushPlanPath, original);

    const result = await processOpenClawFlushPlanFile({
      enabled: true,
      workspaceDir,
      serviceId: SERVICE_ID,
      reason: "test-concurrent-tail",
      ingestor: {
        async ingestBulkImportBatch() {
          await appendFile(flushPlanPath, appended, "utf8");
        },
      },
    });

    assert.equal(result.status, "processed_preserved_tail");
    assert.equal(await readFile(flushPlanPath, "utf8"), appended);
  });
});

test("processOpenClawFlushPlanFile does not append rotated snapshots to symlinked replacements", async () => {
  await withWorkspace(async (workspaceDir, flushPlanPath) => {
    const original = "- Original plan being imported.\n";
    const rotated =
      `- Concurrent replacement that does not contain the original plan.\n${"x".repeat(8_000_000)}\n`;
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "remnic-flush-outside-"));
    const outsidePath = path.join(outsideDir, "outside.md");
    await writeFile(outsidePath, "outside\n", "utf8");
    await writeFlushPlan(flushPlanPath, original);

    let replaceWithSymlink: Promise<void> | undefined;
    try {
      const result = await processOpenClawFlushPlanFile({
        enabled: true,
        workspaceDir,
        serviceId: SERVICE_ID,
        ingestor: {
          async ingestBulkImportBatch() {
            await writeFile(flushPlanPath, rotated, "utf8");
            replaceWithSymlink = (async () => {
              for (let attempt = 0; attempt < 1000; attempt += 1) {
                try {
                  const stat = await lstat(flushPlanPath);
                  if (
                    stat.isFile() &&
                    stat.size === 0 &&
                    (await readFile(flushPlanPath, "utf8")) === ""
                  ) {
                    await rm(flushPlanPath, { force: true });
                    await symlink(outsidePath, flushPlanPath);
                    return;
                  }
                } catch {}
                await new Promise((resolve) => setTimeout(resolve, 1));
              }
              assert.fail("test did not replace the recreated flush-plan with a symlink");
            })();
          },
        },
      });

      await replaceWithSymlink;

      assert.equal(result.status, "processed_cleanup_deferred");
      assert.match(result.reason ?? "", /unsafe target/);
      assert.equal(await readFile(outsidePath, "utf8"), "outside\n");
      assert.equal((await lstat(flushPlanPath)).isSymbolicLink(), true);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

test("processOpenClawFlushPlanFile chunks oversized snapshots before clearing", async () => {
  await withWorkspace(async (workspaceDir, flushPlanPath) => {
    const maxTurnChars = 260;
    const content = [
      `- ${"Alpha flush-plan detail ".repeat(8)}`,
      `- ${"Beta flush-plan detail ".repeat(8)}`,
      `- ${"Gamma flush-plan detail ".repeat(8)}`,
    ].join("\n");
    await writeFlushPlan(flushPlanPath, content);
    const received: ImportTurn[] = [];
    const batchSizes: number[] = [];

    const result = await processOpenClawFlushPlanFile({
      enabled: true,
      workspaceDir,
      serviceId: SERVICE_ID,
      maxTurnChars,
      now: () => new Date("2026-06-24T00:00:00.000Z"),
      ingestor: {
        async ingestBulkImportBatch(turns) {
          batchSizes.push(turns.length);
          received.push(...turns);
        },
      },
    });

    assert.equal(result.status, "processed");
    assert.equal(await readFile(flushPlanPath, "utf8"), "");
    assert.ok(received.length > 1);
    assert.deepEqual(batchSizes, Array(received.length).fill(1));
    assert.ok(received.every((turn) => turn.content.length <= maxTurnChars));
    assert.equal(
      new Set(received.map((turn) => turn.timestamp)).size,
      received.length,
    );
    assert.ok(
      received.every(
        (turn) =>
          turn.importProvenance?.sourceTimestamp ===
          "2026-06-24T00:00:00.000Z",
      ),
    );
    assert.equal(
      received.map((turn) => String(turn.rawContent ?? "")).join(""),
      content.trim(),
    );
    assert.equal(received[0].importProvenance?.metadata?.chunkIndex, 0);
    assert.equal(received[0].persistProcessedFingerprint, true);
    assert.equal(typeof received[0].turnFingerprint, "string");
    assert.equal(
      received.at(-1)?.importProvenance?.metadata?.chunkCount,
      received.length,
    );
  });
});

test("processOpenClawFlushPlanFile reuses pending marker chunk fingerprints after config changes", async () => {
  await withWorkspace(async (workspaceDir, flushPlanPath) => {
    const firstMaxTurnChars = 260;
    const content = [
      `- ${"Alpha pending flush-plan detail ".repeat(8)}`,
      `- ${"Beta pending flush-plan detail ".repeat(8)}`,
      `- ${"Gamma pending flush-plan detail ".repeat(8)}`,
    ].join("\n");
    await writeFlushPlan(flushPlanPath, content);
    const firstTurns: ImportTurn[] = [];

    await assert.rejects(
      processOpenClawFlushPlanFile({
        enabled: true,
        workspaceDir,
        serviceId: SERVICE_ID,
        maxTurnChars: firstMaxTurnChars,
        now: () => new Date("2026-06-24T00:00:00.000Z"),
        ingestor: {
          async ingestBulkImportBatch(turns) {
            firstTurns.push(...turns);
            throw new Error("backend unavailable");
          },
        },
      }),
      /backend unavailable/,
    );

    assert.ok(firstTurns.length > 1);
    const marker = JSON.parse(
      await readFile(processedMarkerPath(flushPlanPath), "utf8"),
    ) as {
      status?: string;
      processedChunks?: unknown[];
    };
    assert.equal(marker.status, "pending");
    assert.equal(marker.processedChunks?.length, firstTurns.length);

    const secondTurns: ImportTurn[] = [];
    const result = await processOpenClawFlushPlanFile({
      enabled: true,
      workspaceDir,
      serviceId: SERVICE_ID,
      maxTurnChars: 4000,
      ingestor: {
        async ingestBulkImportBatch(turns) {
          secondTurns.push(...turns);
        },
      },
    });

    assert.equal(result.status, "processed_marker_recovered");
    assert.deepEqual(
      secondTurns.map((turn) => turn.rawContent),
      firstTurns.map((turn) => turn.rawContent),
    );
    assert.deepEqual(
      secondTurns.map((turn) => turn.turnFingerprint),
      firstTurns.map((turn) => turn.turnFingerprint),
    );
    assert.deepEqual(
      secondTurns.map((turn) => turn.timestamp),
      firstTurns.map((turn) => turn.timestamp),
    );
  });
});

test("processOpenClawFlushPlanFile recovers a processed prefix from a marker", async () => {
  await withWorkspace(async (workspaceDir, flushPlanPath) => {
    const content = "- Cleanup can be retried after this was ingested.\n";
    await writeFlushPlan(flushPlanPath, content);
    await writeFile(
      processedMarkerPath(flushPlanPath),
      `${JSON.stringify(
        {
          version: 1,
          processedHash: sha256(content),
          processedBytes: Buffer.byteLength(content, "utf8"),
          processedAt: "2026-06-24T00:00:00.000Z",
          reason: "test-marker-recovery",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    let calls = 0;

    const result = await processOpenClawFlushPlanFile({
      enabled: true,
      workspaceDir,
      serviceId: SERVICE_ID,
      ingestor: {
        async ingestBulkImportBatch() {
          calls += 1;
        },
      },
    });

    assert.equal(result.status, "processed_marker_recovered");
    assert.equal(calls, 0);
    assert.equal(await readFile(flushPlanPath, "utf8"), "");
  });
});

test("processOpenClawFlushPlanFile clears stale processed markers when the plan is empty", async () => {
  await withWorkspace(async (workspaceDir, flushPlanPath) => {
    const content = "- Future flush plan starts with old processed bytes.\n";
    await writeFlushPlan(flushPlanPath, "");
    const markerPath = processedMarkerPath(flushPlanPath);
    await writeFile(
      markerPath,
      `${JSON.stringify(
        {
          version: 1,
          processedHash: sha256(content),
          processedBytes: Buffer.byteLength(content, "utf8"),
          processedContent: content,
          processedAt: "2026-06-24T00:00:00.000Z",
          reason: "stale-empty-marker",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const first = await processOpenClawFlushPlanFile({
      enabled: true,
      workspaceDir,
      serviceId: SERVICE_ID,
      ingestor: {
        async ingestBulkImportBatch() {
          assert.fail("empty flush-plan files must not import");
        },
      },
    });

    assert.equal(first.status, "empty");
    await assert.rejects(readFile(markerPath, "utf8"), /ENOENT/);

    let calls = 0;
    await writeFile(flushPlanPath, content, "utf8");
    const second = await processOpenClawFlushPlanFile({
      enabled: true,
      workspaceDir,
      serviceId: SERVICE_ID,
      ingestor: {
        async ingestBulkImportBatch(turns) {
          calls += 1;
          const [turn] = turns;
          assert.ok(turn);
          assert.equal(turn.rawContent, content.trim());
        },
      },
    });

    assert.equal(second.status, "processed");
    assert.equal(calls, 1);
  });
});

test("processOpenClawFlushPlanFile replays only a pending marker prefix before preserving tail", async () => {
  await withWorkspace(async (workspaceDir, flushPlanPath) => {
    const processed = "- Imported before marker promotion crashed.\n";
    const tail = "- Appended after the successful import.\n";
    const markerPath = processedMarkerPath(flushPlanPath);
    await writeFlushPlan(flushPlanPath, `${processed}${tail}`);
    await writeFile(
      markerPath,
      `${JSON.stringify(
        {
          version: 1,
          status: "pending",
          processedHash: sha256(processed),
          processedBytes: Buffer.byteLength(processed, "utf8"),
          processedContent: processed,
          processedAt: "2026-06-24T00:00:00.000Z",
          reason: "pending-marker-recovery",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const receivedRaw: string[] = [];

    const first = await processOpenClawFlushPlanFile({
      enabled: true,
      workspaceDir,
      serviceId: SERVICE_ID,
      ingestor: {
        async ingestBulkImportBatch(turns) {
          const [turn] = turns;
          assert.ok(turn);
          const rawContent = turn.rawContent;
          assert.ok(typeof rawContent === "string");
          receivedRaw.push(rawContent);
        },
      },
    });

    assert.equal(first.status, "processed_marker_recovered_tail");
    assert.deepEqual(receivedRaw, [processed.trim()]);
    assert.equal(await readFile(flushPlanPath, "utf8"), tail);
    await assert.rejects(readFile(markerPath, "utf8"), /ENOENT/);

    const second = await processOpenClawFlushPlanFile({
      enabled: true,
      workspaceDir,
      serviceId: SERVICE_ID,
      ingestor: {
        async ingestBulkImportBatch(turns) {
          const [turn] = turns;
          assert.ok(turn);
          const rawContent = turn.rawContent;
          assert.ok(typeof rawContent === "string");
          receivedRaw.push(rawContent);
        },
      },
    });

    assert.equal(second.status, "processed");
    assert.deepEqual(receivedRaw, [processed.trim(), tail.trim()]);
    assert.equal(await readFile(flushPlanPath, "utf8"), "");
  });
});

test("processOpenClawFlushPlanFile keeps a pending marker when recovery import fails", async () => {
  await withWorkspace(async (workspaceDir, flushPlanPath) => {
    const processed = "- Pending import should be retried later.\n";
    const tail = "- Later flush-plan note.\n";
    const markerPath = processedMarkerPath(flushPlanPath);
    await writeFlushPlan(flushPlanPath, `${processed}${tail}`);
    await writeFile(
      markerPath,
      `${JSON.stringify(
        {
          version: 1,
          status: "pending",
          processedHash: sha256(processed),
          processedBytes: Buffer.byteLength(processed, "utf8"),
          processedContent: processed,
          processedAt: "2026-06-24T00:00:00.000Z",
          reason: "pending-marker-failure",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await assert.rejects(
      processOpenClawFlushPlanFile({
        enabled: true,
        workspaceDir,
        serviceId: SERVICE_ID,
        ingestor: {
          async ingestBulkImportBatch() {
            throw new Error("backend still unavailable");
          },
        },
      }),
      /backend still unavailable/,
    );

    assert.equal(await readFile(flushPlanPath, "utf8"), `${processed}${tail}`);
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as {
      status?: string;
    };
    assert.equal(marker.status, "pending");
  });
});

test("processOpenClawFlushPlanFile recovers interrupted cleanup snapshots after restart", async () => {
  await withWorkspace(async (workspaceDir, flushPlanPath) => {
    const processed = "- Already ingested before cleanup crashed.\n";
    const tail = "- Tail appended before the crash.\n";
    const cleanupPath = path.join(
      path.dirname(flushPlanPath),
      "flush-plan.cleanup-1234.restart.md",
    );
    const markerPath = processedMarkerPath(flushPlanPath);
    await mkdir(path.dirname(flushPlanPath), { recursive: true });
    await writeFile(flushPlanPath, "", "utf8");
    await writeFile(cleanupPath, `${processed}${tail}`, "utf8");
    await writeFile(
      markerPath,
      `${JSON.stringify(
        {
          version: 1,
          processedHash: sha256(processed),
          processedBytes: Buffer.byteLength(processed, "utf8"),
          processedContent: processed,
          processedAt: "2026-06-24T00:00:00.000Z",
          reason: "restart-cleanup-recovery",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const received: ImportTurn[] = [];

    const result = await processOpenClawFlushPlanFile({
      enabled: true,
      workspaceDir,
      serviceId: SERVICE_ID,
      ingestor: {
        async ingestBulkImportBatch(turns) {
          received.push(...turns);
        },
      },
    });

    assert.equal(result.status, "processed");
    assert.equal(received.length, 1);
    assert.equal(received[0].rawContent, tail.trim());
    assert.equal(await readFile(flushPlanPath, "utf8"), "");
    await assert.rejects(readFile(cleanupPath, "utf8"), /ENOENT/);
    await assert.rejects(readFile(markerPath, "utf8"), /ENOENT/);
  });
});

test("processOpenClawFlushPlanFile recovers multiple cleanup snapshots in append order", async () => {
  await withWorkspace(async (workspaceDir, flushPlanPath) => {
    const older = "- Older cleanup snapshot note.\n";
    const newer = "- Newer cleanup snapshot follow-up.\n";
    const olderCleanupPath = path.join(
      path.dirname(flushPlanPath),
      "flush-plan.cleanup-1111.1000.older.md",
    );
    const newerCleanupPath = path.join(
      path.dirname(flushPlanPath),
      "flush-plan.cleanup-9999.2000.newer.md",
    );
    await mkdir(path.dirname(flushPlanPath), { recursive: true });
    await writeFile(flushPlanPath, "", "utf8");
    await writeFile(olderCleanupPath, older, "utf8");
    await writeFile(newerCleanupPath, newer, "utf8");
    const received: ImportTurn[] = [];

    const result = await processOpenClawFlushPlanFile({
      enabled: true,
      workspaceDir,
      serviceId: SERVICE_ID,
      ingestor: {
        async ingestBulkImportBatch(turns) {
          received.push(...turns);
        },
      },
    });

    assert.equal(result.status, "processed");
    assert.equal(received.length, 1);
    assert.equal(received[0].rawContent, `${older}${newer}`.trim());
    assert.equal(await readFile(flushPlanPath, "utf8"), "");
    await assert.rejects(readFile(olderCleanupPath, "utf8"), /ENOENT/);
    await assert.rejects(readFile(newerCleanupPath, "utf8"), /ENOENT/);
  });
});

test("processOpenClawFlushPlanFile clears markers after processed-only cleanup recovery", async () => {
  await withWorkspace(async (workspaceDir, flushPlanPath) => {
    const processed = "- Already ingested before cleanup crashed.\n";
    const cleanupPath = path.join(
      path.dirname(flushPlanPath),
      "flush-plan.cleanup-2468.restart.md",
    );
    const markerPath = processedMarkerPath(flushPlanPath);
    await mkdir(path.dirname(flushPlanPath), { recursive: true });
    await writeFile(flushPlanPath, "", "utf8");
    await writeFile(cleanupPath, processed, "utf8");
    await writeFile(
      markerPath,
      `${JSON.stringify(
        {
          version: 1,
          status: "processed",
          processedHash: sha256(processed),
          processedBytes: Buffer.byteLength(processed, "utf8"),
          processedContent: processed,
          processedAt: "2026-06-24T00:00:00.000Z",
          reason: "restart-cleanup-recovery",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const first = await processOpenClawFlushPlanFile({
      enabled: true,
      workspaceDir,
      serviceId: SERVICE_ID,
      ingestor: {
        async ingestBulkImportBatch() {
          assert.fail("processed-only cleanup recovery should not reingest");
        },
      },
    });

    assert.equal(first.status, "empty");
    await assert.rejects(readFile(cleanupPath, "utf8"), /ENOENT/);
    await assert.rejects(readFile(markerPath, "utf8"), /ENOENT/);

    await writeFile(flushPlanPath, processed, "utf8");
    const received: ImportTurn[] = [];
    const second = await processOpenClawFlushPlanFile({
      enabled: true,
      workspaceDir,
      serviceId: SERVICE_ID,
      ingestor: {
        async ingestBulkImportBatch(turns) {
          received.push(...turns);
        },
      },
    });

    assert.equal(second.status, "processed");
    assert.equal(received.length, 1);
    assert.equal(received[0].rawContent, processed.trim());
  });
});

test("processOpenClawFlushPlanFile ignores a marker cleared during cleanup recovery", async () => {
  await withWorkspace(async (workspaceDir, flushPlanPath) => {
    const processed = "- Fresh note repeats the old processed snapshot.\n";
    const cleanupPath = path.join(
      path.dirname(flushPlanPath),
      "flush-plan.cleanup-1357.restart.md",
    );
    const markerPath = processedMarkerPath(flushPlanPath);
    await mkdir(path.dirname(flushPlanPath), { recursive: true });
    await writeFile(flushPlanPath, processed, "utf8");
    await writeFile(cleanupPath, processed, "utf8");
    await writeFile(
      markerPath,
      `${JSON.stringify(
        {
          version: 1,
          status: "processed",
          processedHash: sha256(processed),
          processedBytes: Buffer.byteLength(processed, "utf8"),
          processedContent: processed,
          processedAt: "2026-06-24T00:00:00.000Z",
          reason: "restart-cleanup-recovery",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const received: ImportTurn[] = [];

    const result = await processOpenClawFlushPlanFile({
      enabled: true,
      workspaceDir,
      serviceId: SERVICE_ID,
      ingestor: {
        async ingestBulkImportBatch(turns) {
          received.push(...turns);
        },
      },
    });

    assert.equal(result.status, "processed");
    assert.equal(received.length, 1);
    assert.equal(received[0].rawContent, processed.trim());
    await assert.rejects(readFile(cleanupPath, "utf8"), /ENOENT/);
    await assert.rejects(readFile(markerPath, "utf8"), /ENOENT/);
  });
});

test("processOpenClawFlushPlanFile imports restored cleanup tail that repeats the processed prefix", async () => {
  await withWorkspace(async (workspaceDir, flushPlanPath) => {
    const repeated = "- Same durable note appears twice.\n";
    const cleanupPath = path.join(
      path.dirname(flushPlanPath),
      "flush-plan.cleanup-9753.restart.md",
    );
    const markerPath = processedMarkerPath(flushPlanPath);
    await mkdir(path.dirname(flushPlanPath), { recursive: true });
    await writeFile(flushPlanPath, "", "utf8");
    await writeFile(cleanupPath, `${repeated}${repeated}`, "utf8");
    await writeFile(
      markerPath,
      `${JSON.stringify(
        {
          version: 1,
          status: "processed",
          processedHash: sha256(repeated),
          processedBytes: Buffer.byteLength(repeated, "utf8"),
          processedContent: repeated,
          processedAt: "2026-06-24T00:00:00.000Z",
          reason: "restart-repeated-tail",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const received: ImportTurn[] = [];

    const result = await processOpenClawFlushPlanFile({
      enabled: true,
      workspaceDir,
      serviceId: SERVICE_ID,
      ingestor: {
        async ingestBulkImportBatch(turns) {
          received.push(...turns);
        },
      },
    });

    assert.equal(result.status, "processed");
    assert.equal(received.length, 1);
    assert.equal(received[0].rawContent, repeated.trim());
    assert.equal(await readFile(flushPlanPath, "utf8"), "");
    await assert.rejects(readFile(cleanupPath, "utf8"), /ENOENT/);
    await assert.rejects(readFile(markerPath, "utf8"), /ENOENT/);
  });
});

test("processOpenClawFlushPlanFile restores cleanup tails that only match current content later", async () => {
  await withWorkspace(async (workspaceDir, flushPlanPath) => {
    const processed = "- Already ingested before cleanup crashed.\n";
    const tail = "- Repeated tail note.\n";
    const current = "- Fresh note before repeated tail.\n";
    const cleanupPath = path.join(
      path.dirname(flushPlanPath),
      "flush-plan.cleanup-9012.restart.md",
    );
    const markerPath = processedMarkerPath(flushPlanPath);
    await mkdir(path.dirname(flushPlanPath), { recursive: true });
    await writeFile(flushPlanPath, `${current}${tail}`, "utf8");
    await writeFile(cleanupPath, `${processed}${tail}`, "utf8");
    await writeFile(
      markerPath,
      `${JSON.stringify(
        {
          version: 1,
          processedHash: sha256(processed),
          processedBytes: Buffer.byteLength(processed, "utf8"),
          processedContent: processed,
          processedAt: "2026-06-24T00:00:00.000Z",
          reason: "restart-tail-non-prefix",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const received: ImportTurn[] = [];

    const result = await processOpenClawFlushPlanFile({
      enabled: true,
      workspaceDir,
      serviceId: SERVICE_ID,
      ingestor: {
        async ingestBulkImportBatch(turns) {
          received.push(...turns);
        },
      },
    });

    assert.equal(result.status, "processed");
    assert.equal(received.length, 1);
    assert.equal(received[0].rawContent, `${tail}${current}${tail}`.trim());
    assert.equal(await readFile(flushPlanPath, "utf8"), "");
    await assert.rejects(readFile(cleanupPath, "utf8"), /ENOENT/);
    await assert.rejects(readFile(markerPath, "utf8"), /ENOENT/);
  });
});

test("processOpenClawFlushPlanFile does not duplicate tails already restored before restart", async () => {
  await withWorkspace(async (workspaceDir, flushPlanPath) => {
    const processed = "- Already ingested before cleanup crashed.\n";
    const tail = "- Tail already restored before the crash.\n";
    const cleanupPath = path.join(
      path.dirname(flushPlanPath),
      "flush-plan.cleanup-5678.restart.md",
    );
    const markerPath = processedMarkerPath(flushPlanPath);
    await mkdir(path.dirname(flushPlanPath), { recursive: true });
    await writeFile(flushPlanPath, tail, "utf8");
    await writeFile(cleanupPath, `${processed}${tail}`, "utf8");
    await writeFile(
      markerPath,
      `${JSON.stringify(
        {
          version: 1,
          processedHash: sha256(processed),
          processedBytes: Buffer.byteLength(processed, "utf8"),
          processedContent: processed,
          processedAt: "2026-06-24T00:00:00.000Z",
          reason: "restart-tail-dedupe",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const received: ImportTurn[] = [];

    const result = await processOpenClawFlushPlanFile({
      enabled: true,
      workspaceDir,
      serviceId: SERVICE_ID,
      ingestor: {
        async ingestBulkImportBatch(turns) {
          received.push(...turns);
        },
      },
    });

    assert.equal(result.status, "processed");
    assert.equal(received.length, 1);
    assert.equal(received[0].rawContent, tail.trim());
    assert.equal(await readFile(flushPlanPath, "utf8"), "");
    await assert.rejects(readFile(cleanupPath, "utf8"), /ENOENT/);
  });
});

test("processOpenClawFlushPlanFile does not delete non-prefix stale marker content", async () => {
  await withWorkspace(async (workspaceDir, flushPlanPath) => {
    const content = "- Previously processed content that repeats later.\n";
    const nextContent = "- New non-prefix content.\n";
    await writeFlushPlan(flushPlanPath, content);
    let calls = 0;
    const receivedRaw: string[] = [];

    const first = await processOpenClawFlushPlanFile({
      enabled: true,
      workspaceDir,
      serviceId: SERVICE_ID,
      reason: "test-cleanup-deferred",
      ingestor: {
        async ingestBulkImportBatch() {
          calls += 1;
          await writeFile(flushPlanPath, `${nextContent}${content}`, "utf8");
        },
      },
    });

    assert.equal(first.status, "processed_cleanup_deferred");

    const second = await processOpenClawFlushPlanFile({
      enabled: true,
      workspaceDir,
      serviceId: SERVICE_ID,
      ingestor: {
        async ingestBulkImportBatch(turns) {
          calls += 1;
          const [turn] = turns;
          assert.ok(turn);
          const rawContent = turn.rawContent;
          assert.ok(typeof rawContent === "string");
          receivedRaw.push(rawContent);
        },
      },
    });

    assert.equal(second.status, "processed");
    assert.equal(calls, 2);
    assert.deepEqual(receivedRaw, [`${nextContent}${content}`.trim()]);
    assert.equal(await readFile(flushPlanPath, "utf8"), "");
  });
});

test("processOpenClawFlushPlanFile clears stale markers before ingesting new content", async () => {
  await withWorkspace(async (workspaceDir, flushPlanPath) => {
    const processed = "- Already cleaned up content.\n";
    const current = "- Brand new flush-plan content.\n";
    await writeFlushPlan(flushPlanPath, current);
    await writeFile(
      processedMarkerPath(flushPlanPath),
      `${JSON.stringify(
        {
          version: 1,
          processedHash: sha256(processed),
          processedBytes: Buffer.byteLength(processed, "utf8"),
          processedContent: processed,
          processedAt: "2026-06-24T00:00:00.000Z",
          reason: "stale-marker",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    let calls = 0;

    const result = await processOpenClawFlushPlanFile({
      enabled: true,
      workspaceDir,
      serviceId: SERVICE_ID,
      ingestor: {
        async ingestBulkImportBatch(turns) {
          calls += 1;
          const [turn] = turns;
          assert.ok(turn);
          assert.equal(turn.rawContent, current.trim());
        },
      },
    });

    assert.equal(result.status, "processed");
    assert.equal(calls, 1);
    assert.equal(await readFile(flushPlanPath, "utf8"), "");
  });
});

test("processOpenClawFlushPlanFile clears stale pending markers before ingesting new content", async () => {
  await withWorkspace(async (workspaceDir, flushPlanPath) => {
    const processed = "- Pending marker content that is no longer a prefix.\n";
    const current = "- Current content starts elsewhere.\n";
    await writeFlushPlan(flushPlanPath, `${current}${processed}`);
    await writeFile(
      processedMarkerPath(flushPlanPath),
      `${JSON.stringify(
        {
          version: 1,
          status: "pending",
          processedHash: sha256(processed),
          processedBytes: Buffer.byteLength(processed, "utf8"),
          processedContent: processed,
          processedAt: "2026-06-24T00:00:00.000Z",
          reason: "stale-pending-marker",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const receivedRaw: string[] = [];

    const result = await processOpenClawFlushPlanFile({
      enabled: true,
      workspaceDir,
      serviceId: SERVICE_ID,
      ingestor: {
        async ingestBulkImportBatch(turns) {
          const [turn] = turns;
          assert.ok(turn);
          const rawContent = turn.rawContent;
          assert.ok(typeof rawContent === "string");
          receivedRaw.push(rawContent);
        },
      },
    });

    assert.equal(result.status, "processed");
    assert.deepEqual(receivedRaw, [`${current}${processed}`.trim()]);
    assert.equal(await readFile(flushPlanPath, "utf8"), "");
  });
});

test("processOpenClawFlushPlanFile passes the optional deadline to bulk import", async () => {
  await withWorkspace(async (workspaceDir, flushPlanPath) => {
    await writeFlushPlan(flushPlanPath, "- Deadline should be forwarded.\n");
    const deadlineMs = Date.now() + 1234;
    let receivedDeadline: number | undefined;
    let receivedFailureGate: boolean | undefined;
    let receivedSourceValidAtContext: boolean | undefined;

    await processOpenClawFlushPlanFile({
      enabled: true,
      workspaceDir,
      serviceId: SERVICE_ID,
      deadlineMs,
      ingestor: {
        async ingestBulkImportBatch(_turns, options) {
          receivedDeadline = options?.deadlineMs;
          receivedFailureGate = options?.failOnExtractionFailure;
          receivedSourceValidAtContext = options?.includeSourceValidAtContext;
        },
      },
    });

    assert.equal(receivedDeadline, deadlineMs);
    assert.equal(receivedFailureGate, true);
    assert.equal(receivedSourceValidAtContext, false);
  });
});

test("processOpenClawFlushPlanFile leaves the file intact when ingestion reports failure", async () => {
  await withWorkspace(async (workspaceDir, flushPlanPath) => {
    const content = "- This should remain pending after a backend failure.\n";
    await writeFlushPlan(flushPlanPath, content);

    await assert.rejects(
      processOpenClawFlushPlanFile({
        enabled: true,
        workspaceDir,
        serviceId: SERVICE_ID,
        ingestor: {
          async ingestBulkImportBatch() {
            return {
              attemptedTurnCount: 1,
              extractionCount: 1,
              persistedCount: 0,
              durableOutputCount: 0,
              skippedCount: 0,
              failedCount: 1,
            };
          },
        },
      }),
      /OpenClaw flush-plan import failed/,
    );

    assert.equal(await readFile(flushPlanPath, "utf8"), content);
    const marker = JSON.parse(
      await readFile(processedMarkerPath(flushPlanPath), "utf8"),
    ) as { status?: string };
    assert.equal(marker.status, "pending");
  });
});

test("processOpenClawFlushPlanFile defers cleanup without retry after metadata-only failure", async () => {
  await withWorkspace(async (workspaceDir, flushPlanPath) => {
    const content = "- This was durably imported before metadata save failed.\n";
    await writeFlushPlan(flushPlanPath, content);
    let importCalls = 0;

    const first = await processOpenClawFlushPlanFile({
      enabled: true,
      workspaceDir,
      serviceId: SERVICE_ID,
      ingestor: {
        async ingestBulkImportBatch() {
          importCalls += 1;
          return {
            attemptedTurnCount: 1,
            extractionCount: 1,
            persistedCount: 1,
            durableOutputCount: 1,
            skippedCount: 0,
            failedCount: 0,
            postPersistMetadataFailureCount: 1,
          };
        },
      },
    });

    assert.equal(first.status, "processed_cleanup_deferred");
    assert.match(first.reason ?? "", /metadata persistence was incomplete/);
    assert.equal(await readFile(flushPlanPath, "utf8"), content);
    const marker = JSON.parse(
      await readFile(processedMarkerPath(flushPlanPath), "utf8"),
    ) as { status?: string };
    assert.equal(marker.status, "processed");

    const second = await processOpenClawFlushPlanFile({
      enabled: true,
      workspaceDir,
      serviceId: SERVICE_ID,
      ingestor: {
        async ingestBulkImportBatch() {
          assert.fail("processed marker recovery must not reimport content");
        },
      },
    });

    assert.equal(second.status, "processed_marker_recovered");
    assert.equal(await readFile(flushPlanPath, "utf8"), "");
    await assert.rejects(readFile(processedMarkerPath(flushPlanPath), "utf8"), /ENOENT/);
    assert.equal(importCalls, 1);
  });
});

test("processOpenClawFlushPlanFile preserves only failed tail after partial durable import", async () => {
  await withWorkspace(async (workspaceDir, flushPlanPath) => {
    const content =
      `- First durable note ${"a".repeat(180)}\n` +
      `- Later failed note ${"b".repeat(180)}\n`;
    await writeFlushPlan(flushPlanPath, content);
    let firstProcessedChunk = "";
    let importCalls = 0;

    const first = await processOpenClawFlushPlanFile({
      enabled: true,
      workspaceDir,
      serviceId: SERVICE_ID,
      maxTurnChars: 260,
      ingestor: {
        async ingestBulkImportBatch(turns) {
          importCalls += 1;
          assert.ok(turns.length > 1, "test fixture should produce multiple chunks");
          firstProcessedChunk =
            typeof turns[0]?.rawContent === "string"
              ? turns[0].rawContent
              : (turns[0]?.content ?? "");
          const partialFailure = new Error("later chunk failed") as Error & {
            partialResult: Record<string, unknown>;
          };
          partialFailure.partialResult = {
            attemptedTurnCount: turns.length,
            extractionCount: 1,
            persistedCount: 1,
            durableOutputCount: 1,
            skippedCount: 0,
            failedCount: 1,
            postPersistMetadataFailureCount: 1,
            processedTurnCount: 1,
          };
          throw partialFailure;
        },
      },
    });

    assert.equal(first.status, "processed_cleanup_deferred");
    assert.match(first.reason ?? "", /metadata persistence was incomplete/);
    assert.equal(await readFile(flushPlanPath, "utf8"), content);
    assert.ok(firstProcessedChunk.length > 0);

    const second = await processOpenClawFlushPlanFile({
      enabled: true,
      workspaceDir,
      serviceId: SERVICE_ID,
      maxTurnChars: 260,
      ingestor: {
        async ingestBulkImportBatch() {
          assert.fail("processed prefix recovery must not reimport durable content");
        },
      },
    });

    assert.equal(second.status, "processed_marker_recovered_tail");
    assert.equal(
      await readFile(flushPlanPath, "utf8"),
      content.slice(firstProcessedChunk.length),
    );
    await assert.rejects(readFile(processedMarkerPath(flushPlanPath), "utf8"), /ENOENT/);
    assert.equal(importCalls, 1);
  });
});

test("processOpenClawFlushPlanFile leaves the file intact when ingestion fails", async () => {
  await withWorkspace(async (workspaceDir, flushPlanPath) => {
    const content = "- This should remain pending after failure.\n";
    await writeFlushPlan(flushPlanPath, content);

    await assert.rejects(
      processOpenClawFlushPlanFile({
        enabled: true,
        workspaceDir,
        serviceId: SERVICE_ID,
        ingestor: {
          async ingestBulkImportBatch() {
            throw new Error("extractor unavailable");
          },
        },
      }),
      /extractor unavailable/,
    );

    assert.equal(await readFile(flushPlanPath, "utf8"), content);
    const marker = JSON.parse(
      await readFile(processedMarkerPath(flushPlanPath), "utf8"),
    ) as { status?: string };
    assert.equal(marker.status, "pending");
  });
});

test("processOpenClawFlushPlanFile rejects symlinked flush-plan parent directories", async () => {
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "remnic-flush-plan-outside-"));
  try {
    await withWorkspace(async (workspaceDir, flushPlanPath) => {
      const content = "- Outside flush-plan content must not be touched.\n";
      await writeFile(path.join(outsideDir, "flush-plan.md"), content, "utf8");
      await mkdir(path.dirname(path.dirname(flushPlanPath)), { recursive: true });
      await symlink(outsideDir, path.dirname(flushPlanPath));
      let calls = 0;

      const result = await processOpenClawFlushPlanFile({
        enabled: true,
        workspaceDir,
        serviceId: SERVICE_ID,
        ingestor: {
          async ingestBulkImportBatch() {
            calls += 1;
          },
        },
      });

      assert.equal(result.status, "skipped");
      assert.match(result.reason ?? "", /symlink/);
      assert.equal(calls, 0);
      assert.equal(await readFile(path.join(outsideDir, "flush-plan.md"), "utf8"), content);
    });
  } finally {
    await rm(outsideDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("processOpenClawFlushPlanFile respects the disable switch", async () => {
  await withWorkspace(async (workspaceDir, flushPlanPath) => {
    const content = "- Disabled processing should not read this.\n";
    await writeFlushPlan(flushPlanPath, content);
    let called = false;

    const result = await processOpenClawFlushPlanFile({
      enabled: false,
      workspaceDir,
      serviceId: SERVICE_ID,
      ingestor: {
        async ingestBulkImportBatch() {
          called = true;
        },
      },
    });

    assert.equal(result.status, "disabled");
    assert.equal(called, false);
    assert.equal(await readFile(flushPlanPath, "utf8"), content);
  });
});
