import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  defaultWriteMemoriesToOrchestrator,
  runImporter,
  type ImportedMemory,
  type ImporterAdapter,
  type ImporterWriteTarget,
  type ImportTurn,
} from "@remnic/core";

import {
  cmdImport,
  parseImportArgs,
  parseImportBundleArgs,
  runBundleImportCommand,
  runImportCommand,
  type ImportDispatchArgs,
  type ImportDispatchIO,
} from "./import-dispatch.js";
import type { DetectedBundleEntry } from "./import-bundle-detect.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTarget(): { target: ImporterWriteTarget; received: ImportTurn[][] } {
  const received: ImportTurn[][] = [];
  return {
    target: {
      async ingestBulkImportBatch(turns) {
        received.push(turns.map((t) => ({ ...t })));
      },
      bulkImportWriteNamespace() {
        return "default";
      },
    },
    received,
  };
}

function makeIo(opts: {
  fileContents?: string;
  adapter: ImporterAdapter<unknown>;
  target: ImporterWriteTarget;
}): {
  io: ImportDispatchIO;
  stdoutLines: string[];
  stderrLines: string[];
  getWriteTargetCalls: { count: number };
} {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const getWriteTargetCalls = { count: 0 };
  return {
    io: {
      readFile: async () => opts.fileContents ?? "{}",
      loadAdapter: async () => opts.adapter,
      runImporter,
      getWriteTarget: async () => {
        getWriteTargetCalls.count += 1;
        return opts.target;
      },
      stdout: (line) => stdoutLines.push(line),
      stderr: (line) => stderrLines.push(line),
    },
    stdoutLines,
    stderrLines,
    getWriteTargetCalls,
  };
}

function makeFakeAdapter(memories: ImportedMemory[]): ImporterAdapter<ImportedMemory[]> {
  return {
    name: "chatgpt",
    sourceLabel: "chatgpt",
    parse: () => memories,
    transform: (parsed) => parsed,
    async writeTo(target, batch) {
      return defaultWriteMemoriesToOrchestrator(target, batch);
    },
  };
}

// ---------------------------------------------------------------------------
// parseImportArgs — flag validation (CLAUDE.md rules 14, 51)
// ---------------------------------------------------------------------------

describe("parseImportArgs", () => {
  it("requires --adapter", () => {
    assert.throws(() => parseImportArgs([]), /--adapter/);
  });

  it("rejects an unknown adapter with the valid list", () => {
    assert.throws(
      () => parseImportArgs(["--adapter", "bogus"]),
      /chatgpt, claude, gemini, mem0, supermemory/,
    );
  });

  it("accepts the canonical adapters", () => {
    for (const name of [
      "chatgpt",
      "claude",
      "gemini",
      "mem0",
      "supermemory",
    ] as const) {
      const parsed = parseImportArgs(["--adapter", name]);
      assert.equal(parsed.adapter, name);
    }
  });

  it("rejects --adapter with no following value", () => {
    assert.throws(() => parseImportArgs(["--adapter"]), /requires a value/);
  });

  it("rejects --file with no following value", () => {
    assert.throws(
      () => parseImportArgs(["--adapter", "chatgpt", "--file"]),
      /requires a value/,
    );
  });

  it("rejects --batch-size with non-numeric value", () => {
    assert.throws(
      () =>
        parseImportArgs([
          "--adapter",
          "chatgpt",
          "--batch-size",
          "not-a-number",
        ]),
      /--batch-size/,
    );
  });

  it("rejects --rate-limit of zero", () => {
    assert.throws(
      () =>
        parseImportArgs([
          "--adapter",
          "mem0",
          "--rate-limit",
          "0",
        ]),
      /rateLimit/,
    );
  });

  it("accepts --dry-run as a boolean flag", () => {
    const parsed = parseImportArgs([
      "--adapter",
      "chatgpt",
      "--file",
      "/tmp/x.json",
      "--dry-run",
    ]);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.file, "/tmp/x.json");
  });

  it("accepts --include-conversations", () => {
    const parsed = parseImportArgs([
      "--adapter",
      "chatgpt",
      "--include-conversations",
    ]);
    assert.equal(parsed.includeConversations, true);
  });

  it("rejects unknown flags rather than silently ignoring", () => {
    assert.throws(
      () => parseImportArgs(["--adapter", "chatgpt", "--unknown-opt", "x"]),
      /Unknown argument/,
    );
  });

  it("rejects stray positional arguments rather than silently dropping them", () => {
    assert.throws(
      () => parseImportArgs(["--adapter", "chatgpt", "/tmp/export.json"]),
      /positional argument '\/tmp\/export\.json'/,
    );
  });

  // Cursor bugbot on PR #583: boolean flags must not be consumed before
  // value flags, otherwise `--batch-size --dry-run 10` silently collapses
  // into `--batch-size 10` + `--dry-run`, violating rule 14.
  it("rejects --batch-size when the following token is another --flag", () => {
    assert.throws(
      () =>
        parseImportArgs([
          "--adapter",
          "chatgpt",
          "--batch-size",
          "--dry-run",
          "10",
        ]),
      /--batch-size/,
    );
  });

  it("rejects --rate-limit when the following token is another --flag", () => {
    assert.throws(
      () =>
        parseImportArgs([
          "--adapter",
          "chatgpt",
          "--rate-limit",
          "--include-conversations",
          "5",
        ]),
      /--rate-limit/,
    );
  });

  it("rejects --file when the following token is another --flag", () => {
    assert.throws(
      () =>
        parseImportArgs([
          "--adapter",
          "chatgpt",
          "--file",
          "--dry-run",
        ]),
      /--file/,
    );
  });
});

describe("parseImportBundleArgs", () => {
  it("rejects stray positional arguments after the bundle directory", () => {
    assert.throws(
      () => parseImportBundleArgs(["--all-from-bundle", "/bundle", "/other"]),
      /positional argument '\/other'/,
    );
  });
});

// ---------------------------------------------------------------------------
// runImportCommand — dry-run + full integration (slice 1 contract)
// ---------------------------------------------------------------------------

describe("runImportCommand — slice 1 integration", () => {
  it("dry-run with 3 fake memories reports a plan and never writes", async () => {
    const memories: ImportedMemory[] = [1, 2, 3].map((i) => ({
      content: `memory-${i}`,
      sourceLabel: "chatgpt",
    }));
    const adapter = makeFakeAdapter(memories);
    const { target, received } = makeTarget();
    const { io, stdoutLines, getWriteTargetCalls } = makeIo({ adapter, target });

    const args: ImportDispatchArgs = {
      adapter: "chatgpt",
      file: "/tmp/fake.json",
      dryRun: true,
      includeConversations: false,
    };
    const result = await runImportCommand(args, io);
    assert.ok(result);
    assert.equal(result.dryRun, true);
    assert.equal(result.memoriesPlanned, 3);
    assert.equal(result.memoriesWritten, 0);
    assert.equal(received.length, 0);
    // Dry-run must NOT instantiate the real write target (Cursor review).
    assert.equal(
      getWriteTargetCalls.count,
      0,
      "dry-run must not call getWriteTarget (lazy orchestrator invariant)",
    );
    assert.ok(
      stdoutLines.some((l) => l.includes("Dry-run") && l.includes("3")),
      `expected dry-run stdout, got: ${stdoutLines.join("\n")}`,
    );
  });

  it("non-dry-run hands memories to the orchestrator target", async () => {
    const memories: ImportedMemory[] = [1, 2, 3].map((i) => ({
      content: `memory-${i}`,
      sourceLabel: "chatgpt",
    }));
    const adapter = makeFakeAdapter(memories);
    const { target, received } = makeTarget();
    const { io, stdoutLines, getWriteTargetCalls } = makeIo({ adapter, target });

    const args: ImportDispatchArgs = {
      adapter: "chatgpt",
      file: "/tmp/fake.json",
      dryRun: false,
      batchSize: 2,
      includeConversations: false,
    };
    const result = await runImportCommand(args, io);
    assert.ok(result);
    assert.equal(result.dryRun, false);
    assert.equal(result.memoriesWritten, 3);
    assert.equal(received.length, 2);
    assert.equal(getWriteTargetCalls.count, 1);
    assert.ok(
      stdoutLines.some((l) => l.includes("Imported 3 memories")),
      `expected success stdout, got: ${stdoutLines.join("\n")}`,
    );
  });

  it("surfaces the loader's install-hint error when the adapter is missing", async () => {
    const { target } = makeTarget();
    let writeTargetCalls = 0;
    const io: ImportDispatchIO = {
      readFile: async () => "{}",
      loadAdapter: async () => {
        throw new Error(
          "The 'chatgpt' importer requires the optional @remnic/import-chatgpt package.",
        );
      },
      runImporter,
      getWriteTarget: async () => {
        writeTargetCalls += 1;
        return target;
      },
      stdout: () => {},
      stderr: () => {},
    };
    await assert.rejects(
      () =>
        runImportCommand(
          {
            adapter: "chatgpt",
            file: "/tmp/fake.json",
            dryRun: true,
            includeConversations: false,
          },
          io,
        ),
      /optional @remnic\/import-chatgpt/,
    );
    // Install-hint miss must happen before any write target is requested.
    assert.equal(writeTargetCalls, 0);
  });

  it("rejects ZIP --file inputs instead of decoding binary archives as UTF-8 text", async () => {
    const { target } = makeTarget();
    const adapter = makeFakeAdapter([]);
    const { io } = makeIo({ adapter, target });

    await assert.rejects(
      () =>
        runImportCommand(
          {
            adapter: "chatgpt",
            file: "/tmp/export.ZIP",
            dryRun: true,
            includeConversations: false,
          },
          {
            ...io,
            readFile: async () => {
              throw new Error("ZIP path should be rejected before reading");
            },
          },
        ),
      /ZIP imports are not supported by --file yet/,
    );
  });
});

// ---------------------------------------------------------------------------
// parseImportArgs tilde-expansion (Cursor review fix on PR #583)
// ---------------------------------------------------------------------------

describe("parseImportArgs tilde expansion", () => {
  it("expands a leading ~ in --file", () => {
    const parsed = parseImportArgs([
      "--adapter",
      "chatgpt",
      "--file",
      "~/exports/chatgpt.json",
    ]);
    assert.ok(parsed.file);
    // Expanded path must no longer begin with the tilde.
    assert.ok(
      !parsed.file!.startsWith("~/"),
      `expected ~ expansion, got: ${parsed.file}`,
    );
    // Resolved to an absolute path somewhere under the user's home.
    assert.ok(parsed.file!.includes("/exports/chatgpt.json"));
  });

  it("leaves non-tilde paths unchanged", () => {
    const parsed = parseImportArgs([
      "--adapter",
      "chatgpt",
      "--file",
      "/tmp/export.json",
    ]);
    assert.equal(parsed.file, "/tmp/export.json");
  });
});

// ---------------------------------------------------------------------------
// cmdImport dispose contract (Cursor review fix on PR #583)
// ---------------------------------------------------------------------------

describe("cmdImport dispose contract", () => {
  it("install-hint miss does NOT invoke dispose (no target was materialized)", async () => {
    // `cmdImport` sets process.exitCode when the adapter load fails (install
    // hint path). Snapshot and restore around the test so tsx's
    // exit-code reporting is not polluted.
    const savedExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      let factoryCalls = 0;
      let disposeCalls = 0;
      const factory = async () => {
        factoryCalls += 1;
        return {
          async ingestBulkImportBatch() {},
          bulkImportWriteNamespace() {
            return "default";
          },
        } as ImporterWriteTarget;
      };
      const dispose = async () => {
        disposeCalls += 1;
      };
      // Use `claude` because its package is known NOT to be installed in
      // this test environment — the loader will throw an install hint and
      // `cmdImport` must short-circuit before materializing the target.
      await cmdImport(
        ["--adapter", "claude", "--file", "/dev/null", "--dry-run"],
        factory,
        dispose,
      );
      assert.equal(factoryCalls, 0, "factory must not run when adapter is missing");
      assert.equal(
        disposeCalls,
        0,
        "dispose must not run when write target was never materialized",
      );
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it("disposes when target construction starts and then rejects", async () => {
    const savedExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      let factoryCalls = 0;
      let disposeCalls = 0;
      let constructed = false;
      const adapter = makeFakeAdapter([]);

      const factory = async () => {
        factoryCalls += 1;
        constructed = true;
        throw new Error("target initialization failed");
      };
      const dispose = async () => {
        assert.equal(constructed, true);
        disposeCalls += 1;
      };

      const result = await cmdImport(
        ["--adapter", "chatgpt", "--file", "/tmp/export.json"],
        factory,
        dispose,
        {
          loadAdapter: async () => adapter,
          readFile: async () => "{}",
        },
      );

      assert.equal(result, undefined);
      assert.equal(process.exitCode, 1);
      assert.equal(factoryCalls, 1);
      assert.equal(disposeCalls, 1);
    } finally {
      process.exitCode = savedExitCode;
    }
  });
});

// ---------------------------------------------------------------------------
// Slice 7: --all-from-bundle <dir> auto-detect
// ---------------------------------------------------------------------------

describe("parseImportBundleArgs", () => {
  it("returns undefined when --all-from-bundle is absent", () => {
    assert.equal(parseImportBundleArgs(["--adapter", "chatgpt"]), undefined);
  });

  it("parses --all-from-bundle with a directory argument", () => {
    const args = parseImportBundleArgs([
      "--all-from-bundle",
      "/tmp/bundle",
      "--dry-run",
    ]);
    assert.ok(args);
    assert.equal(args.bundleDir, "/tmp/bundle");
    assert.equal(args.dryRun, true);
  });

  it("rejects --all-from-bundle without a directory argument", () => {
    // `takeValue` throws the generic "--all-from-bundle requires a value"
    // before parseImportBundleArgs can produce the more specific message.
    // Either form satisfies CLAUDE.md rule 14 (no silent defaults).
    assert.throws(
      () => parseImportBundleArgs(["--all-from-bundle"]),
      /--all-from-bundle.*requires (?:a value|a directory)/,
    );
  });

  it("rejects --adapter combined with --all-from-bundle", () => {
    assert.throws(
      () =>
        parseImportBundleArgs([
          "--all-from-bundle",
          "/tmp/bundle",
          "--adapter",
          "chatgpt",
        ]),
      /not valid with --all-from-bundle/,
    );
  });

  it("rejects --file combined with --all-from-bundle", () => {
    assert.throws(
      () =>
        parseImportBundleArgs([
          "--all-from-bundle",
          "/tmp/bundle",
          "--file",
          "/tmp/x.json",
        ]),
      /not valid with --all-from-bundle/,
    );
  });

  it("rejects unknown flags even in bundle mode", () => {
    assert.throws(
      () =>
        parseImportBundleArgs([
          "--all-from-bundle",
          "/tmp/bundle",
          "--bogus",
        ]),
      /Unknown argument/,
    );
  });

  it("rejects extra positional arguments in bundle mode", () => {
    assert.throws(
      () =>
        parseImportBundleArgs([
          "--all-from-bundle",
          "/tmp/bundle",
          "/tmp/other",
        ]),
      /positional argument '\/tmp\/other'/,
    );
  });
});

describe("runBundleImportCommand", () => {
  it("runs one adapter per detected entry and accumulates results", async () => {
    const memories = [{ content: "bundle memory", sourceLabel: "chatgpt" }];
    const adapter = makeFakeAdapter(memories);
    const { target, received } = makeTarget();
    const { io, stdoutLines, getWriteTargetCalls } = makeIo({ adapter, target });

    const detector = (): DetectedBundleEntry[] => [
      { adapter: "chatgpt", filePath: "/bundle/memory.json" },
      { adapter: "chatgpt", filePath: "/bundle/conversations.json", includeConversations: true },
    ];

    const outcome = await runBundleImportCommand(
      {
        bundleDir: "/bundle",
        dryRun: false,
        includeConversations: false,
      },
      io,
      detector,
    );
    assert.equal(outcome.results.length, 2);
    assert.equal(outcome.failedCount, 0);
    // Every entry invoked runImportCommand → one getWriteTarget per entry.
    assert.equal(getWriteTargetCalls.count, 2);
    assert.ok(
      stdoutLines.some((l) => l.includes("Detected 2 imports")),
      `expected detection summary, got: ${stdoutLines.join("\n")}`,
    );
    assert.ok(received.length > 0);
  });

  it("reports an empty bundle gracefully", async () => {
    const adapter = makeFakeAdapter([]);
    const { target } = makeTarget();
    const { io, stdoutLines } = makeIo({ adapter, target });

    const outcome = await runBundleImportCommand(
      { bundleDir: "/empty", dryRun: false, includeConversations: false },
      io,
      () => [],
    );
    assert.deepEqual(outcome.results, []);
    assert.equal(outcome.failedCount, 0);
    assert.ok(
      stdoutLines.some((l) => l.includes("No known exports found")),
      `expected empty-bundle message, got: ${stdoutLines.join("\n")}`,
    );
  });

  it("surfaces per-entry errors to stderr without aborting remaining entries", async () => {
    // First entry will fail (adapter loader throws), second one succeeds.
    let callCount = 0;
    const goodAdapter = makeFakeAdapter([
      { content: "ok", sourceLabel: "claude" },
    ]);
    const { target } = makeTarget();
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const io: ImportDispatchIO = {
      readFile: async () => "{}",
      loadAdapter: async () => {
        callCount += 1;
        if (callCount === 1) {
          throw new Error("boom: chatgpt adapter missing");
        }
        return goodAdapter;
      },
      runImporter,
      getWriteTarget: async () => target,
      stdout: (l) => stdoutLines.push(l),
      stderr: (l) => stderrLines.push(l),
    };

    const outcome = await runBundleImportCommand(
      { bundleDir: "/bundle", dryRun: false, includeConversations: false },
      io,
      () => [
        { adapter: "chatgpt", filePath: "/bundle/memory.json" },
        { adapter: "claude", filePath: "/bundle/projects.json" },
      ],
    );
    // Only the good adapter's result is collected.
    assert.equal(outcome.results.length, 1);
    // Failure count must reflect the one that threw — this is what
    // cmdImport uses to set a non-zero exit code for automation.
    assert.equal(outcome.failedCount, 1);
    assert.ok(
      stderrLines.some((l) => l.includes("adapter 'chatgpt' failed")),
      `expected failure surfaced to stderr, got: ${stderrLines.join("\n")}`,
    );
  });
});
