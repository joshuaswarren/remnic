import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Writable } from "node:stream";

import { runBulkImportCliCommand } from "../cli.js";
import {
  registerBulkImportSource,
  clearBulkImportSources,
} from "./registry.js";
import type { BulkImportSourceAdapter, BulkImportSource } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nullStream(): Writable {
  return new Writable({ write(_chunk, _enc, cb) { cb(); } });
}

function makeDummyAdapter(name: string): BulkImportSourceAdapter {
  return {
    name,
    parse: (): BulkImportSource => ({
      turns: [
        {
          role: "user",
          content: "Hello",
          timestamp: "2024-06-15T10:00:00.000Z",
        },
      ],
      metadata: {
        source: name,
        exportDate: "2024-06-15T00:00:00.000Z",
        messageCount: 1,
        dateRange: {
          from: "2024-01-01T00:00:00.000Z",
          to: "2024-06-15T00:00:00.000Z",
        },
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runBulkImportCliCommand", () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(() => {
    clearBulkImportSources();
    tmpDir = mkdtempSync(join(tmpdir(), "bulk-import-cli-test-"));
    tmpFile = join(tmpDir, "input.json");
    writeFileSync(tmpFile, '{"messages":[]}');
    registerBulkImportSource(makeDummyAdapter("test-source"));
  });

  afterEach(() => {
    clearBulkImportSources();
    try {
      unlinkSync(tmpFile);
    } catch {
      // ignore
    }
  });

  it("throws when non-dryRun is invoked without an ingestBatch callback", async () => {
    await assert.rejects(
      () =>
        runBulkImportCliCommand({
          memoryDir: tmpDir,
          source: "test-source",
          file: tmpFile,
          dryRun: false,
          stdout: nullStream(),
          stderr: nullStream(),
        }),
      (err: Error) => {
        assert.ok(
          err.message.includes("not wired"),
          `expected 'not wired' in: ${err.message}`,
        );
        assert.ok(
          err.message.includes("ingestBatch"),
          `expected 'ingestBatch' in: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("throws when dryRun is undefined and no ingestBatch is provided", async () => {
    await assert.rejects(
      () =>
        runBulkImportCliCommand({
          memoryDir: tmpDir,
          source: "test-source",
          file: tmpFile,
          stdout: nullStream(),
          stderr: nullStream(),
        }),
      (err: Error) => {
        assert.ok(
          err.message.includes("not wired"),
          `expected 'not wired' in: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("invokes the ingestBatch callback when persistence is wired", async () => {
    const seenBatches: number[] = [];
    const result = await runBulkImportCliCommand({
      memoryDir: tmpDir,
      source: "test-source",
      file: tmpFile,
      // dryRun omitted: non-dryRun path exercises the ingestBatch callback.
      ingestBatch: async (turns) => {
        seenBatches.push(turns.length);
        return { memoriesCreated: turns.length, duplicatesSkipped: 0 };
      },
      stdout: nullStream(),
      stderr: nullStream(),
    });
    assert.deepEqual(seenBatches, [1]);
    assert.equal(result.turnsProcessed, 1);
    assert.equal(result.batchesProcessed, 1);
    assert.equal(result.memoriesCreated, 1);
    assert.equal(result.errors.length, 0);
  });

  it("succeeds in dryRun mode", async () => {
    const result = await runBulkImportCliCommand({
      memoryDir: tmpDir,
      source: "test-source",
      file: tmpFile,
      dryRun: true,
      stdout: nullStream(),
      stderr: nullStream(),
    });
    assert.equal(result.turnsProcessed, 1);
    assert.equal(result.memoriesCreated, 0);
  });

  it("strict flag is independent from verbose flag", async () => {
    let capturedOptions: { strict?: boolean } | undefined;
    clearBulkImportSources();
    registerBulkImportSource({
      name: "spy-source",
      parse: (_input: unknown, options?: { strict?: boolean }) => {
        capturedOptions = options;
        return {
          turns: [
            {
              role: "user" as const,
              content: "Hello",
              timestamp: "2024-06-15T10:00:00.000Z",
            },
          ],
          metadata: {
            source: "spy-source",
            exportDate: "2024-06-15T00:00:00.000Z",
            messageCount: 1,
            dateRange: {
              from: "2024-01-01T00:00:00.000Z",
              to: "2024-06-15T00:00:00.000Z",
            },
          },
        };
      },
    });

    // verbose=true, strict not set — strict should NOT be true
    await runBulkImportCliCommand({
      memoryDir: tmpDir,
      source: "spy-source",
      file: tmpFile,
      dryRun: true,
      verbose: true,
      stdout: nullStream(),
      stderr: nullStream(),
    });
    assert.equal(capturedOptions?.strict, false);

    // strict=true, verbose=false — strict should be true
    await runBulkImportCliCommand({
      memoryDir: tmpDir,
      source: "spy-source",
      file: tmpFile,
      dryRun: true,
      verbose: false,
      strict: true,
      stdout: nullStream(),
      stderr: nullStream(),
    });
    assert.equal(capturedOptions?.strict, true);
  });
});
