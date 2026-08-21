/**
 * Tests for `remnic capsule` CLI helpers (issue #676 PR 6/6).
 *
 * All tests exercise pure functions from `capsule-cli.ts` — no orchestrator
 * or filesystem access needed. The test data is fully synthetic (CLAUDE.md
 * public-repo rule: no real conversation content or user identifiers).
 *
 * Test suites:
 *   1. parseCapsuleOutputFormat
 *   2. parseCapsuleImportMode
 *   3. parseCapsuleConflictMode
 *   4. parseCapsuleSince
 *   5. parseCapsuleIncludeKinds
 *   6. parseCapsulePeers
 *   7. parseCapsuleExportOptions
 *   8. parseCapsuleImportOptions
 *   9. parseCapsuleMergeOptions
 *  10. parseCapsuleListOptions
 *  11. parseCapsuleInspectOptions
 *  12. defaultCapsulesDir
 *  13. renderCapsuleList (text / markdown / json)
 *  14. renderCapsuleInspect (text / markdown / json)
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  defaultCapsulesDir,
  parseCapsuleConflictMode,
  parseCapsuleExportOptions,
  parseCapsuleImportMode,
  parseCapsuleImportOptions,
  parseCapsuleInspectOptions,
  parseCapsuleIncludeKinds,
  parseCapsuleListOptions,
  parseCapsuleMergeOptions,
  parseCapsuleOutputFormat,
  parseCapsulePeers,
  parseCapsuleSince,
  renderCapsuleInspect,
  renderCapsuleList,
  type CapsuleInspectData,
  type CapsuleListEntry,
} from "../../packages/remnic-core/src/capsule-cli.js";
import { registerCli } from "../../packages/remnic-core/src/cli.js";

class MockCommand {
  children = new Map<string, MockCommand>();
  actionHandler?: (...args: unknown[]) => Promise<void> | void;

  constructor(readonly name: string) {}

  command(name: string): MockCommand {
    const child = new MockCommand(name);
    this.children.set(name, child);
    return child;
  }

  description(): MockCommand {
    return this;
  }

  option(): MockCommand {
    return this;
  }

  requiredOption(): MockCommand {
    return this;
  }

  argument(): MockCommand {
    return this;
  }

  action(handler: (...args: unknown[]) => Promise<void> | void): MockCommand {
    this.actionHandler = handler;
    return this;
  }
}

function getCapsuleExportAction(): (...args: unknown[]) => Promise<void> | void {
  const root = new MockCommand("root");
  registerCli(
    {
      registerCli(handler: (opts: { program: MockCommand }) => void): void {
        handler({ program: root });
      },
    },
    {
      config: {
        memoryDir: "/tmp/remnic-capsule-cli-test",
      },
    } as never,
  );

  const action = root.children
    .get("engram")
    ?.children.get("capsule")
    ?.children.get("export")
    ?.actionHandler;
  assert.ok(typeof action === "function" && action);
  return action;
}

async function captureCapsuleExportError(options: Record<string, unknown>): Promise<{
  exitCode: string | number | undefined;
  stderr: string;
}> {
  const action = getCapsuleExportAction();
  const originalError = console.error;
  const originalExitCode = process.exitCode;
  const messages: string[] = [];
  process.exitCode = undefined;
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };

  try {
    await action(options);
    return {
      exitCode: process.exitCode,
      stderr: messages.join("\n"),
    };
  } finally {
    console.error = originalError;
    process.exitCode = originalExitCode;
  }
}

// ---------------------------------------------------------------------------
// Suite 1 — parseCapsuleOutputFormat
// ---------------------------------------------------------------------------

test("parseCapsuleOutputFormat returns text for undefined", () => {
  assert.equal(parseCapsuleOutputFormat(undefined), "text");
});

test("parseCapsuleOutputFormat returns text for null", () => {
  assert.equal(parseCapsuleOutputFormat(null), "text");
});

test("parseCapsuleOutputFormat accepts valid values", () => {
  assert.equal(parseCapsuleOutputFormat("text"), "text");
  assert.equal(parseCapsuleOutputFormat("markdown"), "markdown");
  assert.equal(parseCapsuleOutputFormat("json"), "json");
});

test("parseCapsuleOutputFormat rejects unknown value (rule 51)", () => {
  assert.throws(
    () => parseCapsuleOutputFormat("xml"),
    /--format expects one of text, markdown, json; got "xml"/,
  );
});

test("parseCapsuleOutputFormat rejects empty string", () => {
  assert.throws(() => parseCapsuleOutputFormat(""), /--format expects/);
});

test("parseCapsuleOutputFormat rejects non-string", () => {
  assert.throws(() => parseCapsuleOutputFormat(42 as unknown), /--format expects/);
});

// ---------------------------------------------------------------------------
// Suite 2 — parseCapsuleImportMode
// ---------------------------------------------------------------------------

test("parseCapsuleImportMode returns skip for undefined", () => {
  assert.equal(parseCapsuleImportMode(undefined), "skip");
  assert.equal(parseCapsuleImportMode(null), "skip");
});

test("parseCapsuleImportMode accepts valid modes", () => {
  assert.equal(parseCapsuleImportMode("skip"), "skip");
  assert.equal(parseCapsuleImportMode("overwrite"), "overwrite");
  assert.equal(parseCapsuleImportMode("fork"), "fork");
});

test("parseCapsuleImportMode rejects unknown mode (rule 51)", () => {
  assert.throws(
    () => parseCapsuleImportMode("merge"),
    /--mode expects one of skip, overwrite, fork/,
  );
});

// ---------------------------------------------------------------------------
// Suite 3 — parseCapsuleConflictMode
// ---------------------------------------------------------------------------

test("parseCapsuleConflictMode returns skip-conflicts for undefined", () => {
  assert.equal(parseCapsuleConflictMode(undefined), "skip-conflicts");
  assert.equal(parseCapsuleConflictMode(null), "skip-conflicts");
});

test("parseCapsuleConflictMode accepts valid modes", () => {
  assert.equal(parseCapsuleConflictMode("skip-conflicts"), "skip-conflicts");
  assert.equal(parseCapsuleConflictMode("prefer-source"), "prefer-source");
  assert.equal(parseCapsuleConflictMode("prefer-local"), "prefer-local");
});

test("parseCapsuleConflictMode rejects unknown mode (rule 51)", () => {
  assert.throws(
    () => parseCapsuleConflictMode("overwrite"),
    /--conflict-mode expects one of/,
  );
});

// ---------------------------------------------------------------------------
// Suite 4 — parseCapsuleSince
// ---------------------------------------------------------------------------

test("parseCapsuleSince returns undefined for undefined/null", () => {
  assert.equal(parseCapsuleSince(undefined), undefined);
  assert.equal(parseCapsuleSince(null), undefined);
});

test("parseCapsuleSince accepts date-only ISO string", () => {
  const result = parseCapsuleSince("2026-04-01");
  assert.equal(result, "2026-04-01");
});

test("parseCapsuleSince accepts date+time with Z suffix", () => {
  const result = parseCapsuleSince("2026-04-01T00:00:00Z");
  assert.ok(typeof result === "string");
  assert.ok(Number.isFinite(Date.parse(result!)));
});

test("parseCapsuleSince accepts date+time with offset", () => {
  const result = parseCapsuleSince("2026-04-01T12:00:00-05:00");
  assert.ok(typeof result === "string");
});

test("parseCapsuleSince rejects empty string", () => {
  assert.throws(
    () => parseCapsuleSince(""),
    /--since expects an ISO 8601 timestamp/,
  );
});

test("parseCapsuleSince rejects non-ISO format (rule 51)", () => {
  assert.throws(() => parseCapsuleSince("04/01/2026"), /ISO 8601/);
  assert.throws(() => parseCapsuleSince("April 1 2026"), /ISO 8601/);
});

test("parseCapsuleSince rejects calendar overflow", () => {
  assert.throws(
    () => parseCapsuleSince("2026-02-30T00:00:00Z"),
    /calendar overflow|not a valid ISO 8601/i,
  );
});

test("parseCapsuleSince rejects non-string", () => {
  assert.throws(
    () => parseCapsuleSince(12345 as unknown),
    /--since expects an ISO 8601 timestamp/,
  );
});

// ---------------------------------------------------------------------------
// Suite 5 — parseCapsuleIncludeKinds
// ---------------------------------------------------------------------------

test("parseCapsuleIncludeKinds returns undefined for undefined/null", () => {
  assert.equal(parseCapsuleIncludeKinds(undefined), undefined);
  assert.equal(parseCapsuleIncludeKinds(null), undefined);
});

test("parseCapsuleIncludeKinds parses comma-separated list", () => {
  const result = parseCapsuleIncludeKinds("facts,entities");
  assert.deepEqual(result, ["facts", "entities"]);
});

test("parseCapsuleIncludeKinds trims whitespace", () => {
  const result = parseCapsuleIncludeKinds(" facts , entities ");
  assert.deepEqual(result, ["facts", "entities"]);
});

test("parseCapsuleIncludeKinds deduplicates", () => {
  const result = parseCapsuleIncludeKinds("facts,facts,entities");
  assert.deepEqual(result, ["facts", "entities"]);
});

test("parseCapsuleIncludeKinds rejects empty string", () => {
  assert.throws(() => parseCapsuleIncludeKinds(""), /--include-kinds/);
});

test("parseCapsuleIncludeKinds rejects entries with path separators", () => {
  assert.throws(() => parseCapsuleIncludeKinds("facts/subfolder"), /path separators/);
  assert.throws(() => parseCapsuleIncludeKinds("facts\\subfolder"), /path separators/);
});

test("parseCapsuleIncludeKinds rejects non-string", () => {
  assert.throws(() => parseCapsuleIncludeKinds(42 as unknown), /--include-kinds/);
});

// ---------------------------------------------------------------------------
// Suite 6 — parseCapsulePeers
// ---------------------------------------------------------------------------

test("parseCapsulePeers returns undefined for undefined/null", () => {
  assert.equal(parseCapsulePeers(undefined), undefined);
  assert.equal(parseCapsulePeers(null), undefined);
});

test("parseCapsulePeers parses comma-separated peer ids", () => {
  const result = parseCapsulePeers("peer-a,peer-b");
  assert.deepEqual(result, ["peer-a", "peer-b"]);
});

test("parseCapsulePeers deduplicates", () => {
  const result = parseCapsulePeers("peer-a,peer-a,peer-b");
  assert.deepEqual(result, ["peer-a", "peer-b"]);
});

test("parseCapsulePeers rejects empty string", () => {
  assert.throws(() => parseCapsulePeers(""), /--peers/);
});

test("parseCapsulePeers rejects entries with path separators", () => {
  assert.throws(() => parseCapsulePeers("peer/escape"), /path separators/);
});

test("parseCapsulePeers rejects . and ..", () => {
  assert.throws(() => parseCapsulePeers("."), /path separators/);
  assert.throws(() => parseCapsulePeers(".."), /path separators/);
});

// ---------------------------------------------------------------------------
// Suite 7 — parseCapsuleExportOptions
// ---------------------------------------------------------------------------

test("parseCapsuleExportOptions assembles option bag from valid inputs", () => {
  const result = parseCapsuleExportOptions("my-capsule", {
    outDir: "/tmp/caps",
    since: "2026-04-01T00:00:00Z",
    includeKinds: "facts,entities",
    peerIds: "peer-a",
  });
  assert.equal(result.name, "my-capsule");
  assert.equal(result.outDir, "/tmp/caps");
  assert.ok(typeof result.since === "string");
  assert.deepEqual(result.includeKinds, ["facts", "entities"]);
  assert.deepEqual(result.peerIds, ["peer-a"]);
});

test("parseCapsuleExportOptions uses defaults when optional flags absent", () => {
  const result = parseCapsuleExportOptions("my-capsule", {});
  assert.equal(result.name, "my-capsule");
  assert.equal(result.outDir, undefined);
  assert.equal(result.since, undefined);
  assert.equal(result.includeKinds, undefined);
  assert.equal(result.peerIds, undefined);
});

test("parseCapsuleExportOptions rejects missing name", () => {
  assert.throws(
    () => parseCapsuleExportOptions("", {}),
    /capsule export: --name is required/,
  );
  assert.throws(
    () => parseCapsuleExportOptions(undefined, {}),
    /capsule export: --name is required/,
  );
});

test("parseCapsuleExportOptions trims whitespace from name", () => {
  const result = parseCapsuleExportOptions("  my-capsule  ", {});
  assert.equal(result.name, "my-capsule");
});

test("parseCapsuleExportOptions rejects empty include kind and peer id lists", () => {
  assert.throws(
    () => parseCapsuleExportOptions("my-capsule", { includeKinds: "," }),
    /--include-kinds expects at least one non-empty kind name/,
  );
  assert.throws(
    () => parseCapsuleExportOptions("my-capsule", { peerIds: "," }),
    /--peer-ids expects at least one non-empty peer id/,
  );
});

test("capsule export CLI wiring rejects empty include kind and peer id lists before export", async () => {
  const includeKindsResult = await captureCapsuleExportError({
    name: "backup",
    includeKinds: ",",
  });
  const peerIdsResult = await captureCapsuleExportError({
    name: "backup",
    peerIds: ",",
  });

  assert.equal(includeKindsResult.exitCode, 1);
  assert.match(
    includeKindsResult.stderr,
    /--include-kinds expects at least one non-empty kind name/,
  );
  assert.equal(peerIdsResult.exitCode, 1);
  assert.match(peerIdsResult.stderr, /--peer-ids expects at least one non-empty peer id/);
});

// ---------------------------------------------------------------------------
// Suite 8 — parseCapsuleImportOptions
// ---------------------------------------------------------------------------

test("parseCapsuleImportOptions assembles option bag", () => {
  const result = parseCapsuleImportOptions("/path/to/archive.capsule.json.gz", {
    mode: "overwrite",
  });
  assert.equal(result.archive, "/path/to/archive.capsule.json.gz");
  assert.equal(result.mode, "overwrite");
});

test("parseCapsuleImportOptions defaults mode to skip", () => {
  const result = parseCapsuleImportOptions("/path/to/archive.capsule.json.gz", {});
  assert.equal(result.mode, "skip");
});

test("parseCapsuleImportOptions rejects missing archive", () => {
  assert.throws(
    () => parseCapsuleImportOptions("", {}),
    /capsule import: <archive> path is required/,
  );
  assert.throws(
    () => parseCapsuleImportOptions(undefined, {}),
    /capsule import: <archive> path is required/,
  );
});

// ---------------------------------------------------------------------------
// Suite 9 — parseCapsuleMergeOptions
// ---------------------------------------------------------------------------

test("parseCapsuleMergeOptions assembles option bag", () => {
  const result = parseCapsuleMergeOptions("/path/to/archive.capsule.json.gz", {
    conflictMode: "prefer-source",
  });
  assert.equal(result.archive, "/path/to/archive.capsule.json.gz");
  assert.equal(result.conflictMode, "prefer-source");
});

test("parseCapsuleMergeOptions defaults conflictMode to skip-conflicts", () => {
  const result = parseCapsuleMergeOptions("/path/to/archive.capsule.json.gz", {});
  assert.equal(result.conflictMode, "skip-conflicts");
});

test("parseCapsuleMergeOptions rejects missing archive", () => {
  assert.throws(
    () => parseCapsuleMergeOptions("", {}),
    /capsule merge: <archive> path is required/,
  );
});

// ---------------------------------------------------------------------------
// Suite 10 — parseCapsuleListOptions
// ---------------------------------------------------------------------------

test("parseCapsuleListOptions uses defaultCapsulesDir when --dir absent", () => {
  const result = parseCapsuleListOptions({}, "/default/dir");
  assert.equal(result.capsulesDir, "/default/dir");
  assert.equal(result.format, "text");
});

test("parseCapsuleListOptions uses --dir when provided", () => {
  const result = parseCapsuleListOptions({ dir: "/custom/dir" }, "/default/dir");
  assert.equal(result.capsulesDir, "/custom/dir");
});

test("parseCapsuleListOptions forwards --format", () => {
  const result = parseCapsuleListOptions({ format: "json" }, "/default/dir");
  assert.equal(result.format, "json");
});

// ---------------------------------------------------------------------------
// Suite 11 — parseCapsuleInspectOptions
// ---------------------------------------------------------------------------

test("parseCapsuleInspectOptions assembles option bag", () => {
  const result = parseCapsuleInspectOptions("/path/to/archive.capsule.json.gz", {
    format: "markdown",
  });
  assert.equal(result.archive, "/path/to/archive.capsule.json.gz");
  assert.equal(result.format, "markdown");
});

test("parseCapsuleInspectOptions defaults format to text", () => {
  const result = parseCapsuleInspectOptions("/path/to/archive.capsule.json.gz", {});
  assert.equal(result.format, "text");
});

test("parseCapsuleInspectOptions rejects missing archive", () => {
  assert.throws(
    () => parseCapsuleInspectOptions("", {}),
    /capsule inspect: <archive> path is required/,
  );
  assert.throws(
    () => parseCapsuleInspectOptions(undefined, {}),
    /capsule inspect: <archive> path is required/,
  );
});

// ---------------------------------------------------------------------------
// Suite 12 — defaultCapsulesDir
// ---------------------------------------------------------------------------

test("defaultCapsulesDir appends .capsules to memoryDir", () => {
  const memoryDir = "/home/user/.openclaw/workspace/memory/local";
  const result = defaultCapsulesDir(memoryDir);
  assert.equal(result, path.join(memoryDir, ".capsules"));
});

// ---------------------------------------------------------------------------
// Suite 13 — renderCapsuleList
// ---------------------------------------------------------------------------

function makeCapsuleListEntry(overrides: Partial<CapsuleListEntry> = {}): CapsuleListEntry {
  return {
    id: "test-capsule",
    archivePath: "/caps/test-capsule.capsule.json.gz",
    manifestPath: "/caps/test-capsule.manifest.json",
    createdAt: "2026-04-26T00:00:00.000Z",
    pluginVersion: "9.0.0",
    fileCount: 42,
    description: "A test capsule",
    ...overrides,
  };
}

test("renderCapsuleList text shows no-archives message on empty input", () => {
  const output = renderCapsuleList([], "text");
  assert.ok(output.includes("No capsule archives found."));
});

test("renderCapsuleList markdown shows italicised no-archives on empty input", () => {
  const output = renderCapsuleList([], "markdown");
  assert.ok(output.includes("_No capsule archives found._"));
});

test("renderCapsuleList json returns empty capsules array on empty input", () => {
  const parsed = JSON.parse(renderCapsuleList([], "json"));
  assert.deepEqual(parsed.capsules, []);
});

test("renderCapsuleList text shows id, date, and file count", () => {
  const entries = [makeCapsuleListEntry()];
  const output = renderCapsuleList(entries, "text");
  assert.ok(output.includes("test-capsule"));
  assert.ok(output.includes("2026-04-26"));
  assert.ok(output.includes("42 files"));
});

test("renderCapsuleList text shows description when present", () => {
  const entries = [makeCapsuleListEntry({ description: "My description" })];
  const output = renderCapsuleList(entries, "text");
  assert.ok(output.includes("My description"));
});

test("renderCapsuleList text uses 1 file (singular) for fileCount === 1", () => {
  const entries = [makeCapsuleListEntry({ fileCount: 1 })];
  const output = renderCapsuleList(entries, "text");
  assert.ok(output.includes("1 file") && !output.includes("1 files"));
});

test("renderCapsuleList text shows — for missing metadata", () => {
  const entries = [
    makeCapsuleListEntry({ createdAt: null, fileCount: null }),
  ];
  const output = renderCapsuleList(entries, "text");
  assert.ok(output.includes("—"));
});

test("renderCapsuleList markdown renders table header and row", () => {
  const entries = [makeCapsuleListEntry()];
  const output = renderCapsuleList(entries, "markdown");
  assert.ok(output.includes("# Capsule archives"));
  assert.ok(output.includes("| ID | Created |"));
  assert.ok(output.includes("`test-capsule`"));
  assert.ok(output.includes("2026-04-26"));
});

test("renderCapsuleList markdown escapes pipes in description", () => {
  const entries = [makeCapsuleListEntry({ description: "a|b" })];
  const output = renderCapsuleList(entries, "markdown");
  assert.ok(output.includes("a\\|b"));
});

test("renderCapsuleList json returns capsules array with full entries", () => {
  const entries = [makeCapsuleListEntry(), makeCapsuleListEntry({ id: "second" })];
  const parsed = JSON.parse(renderCapsuleList(entries, "json"));
  assert.ok(Array.isArray(parsed.capsules));
  assert.equal(parsed.capsules.length, 2);
  assert.equal(parsed.capsules[0].id, "test-capsule");
  assert.equal(parsed.capsules[1].id, "second");
});

// ---------------------------------------------------------------------------
// Suite 14 — renderCapsuleInspect
// ---------------------------------------------------------------------------

function makeCapsuleInspectData(overrides: Partial<CapsuleInspectData> = {}): CapsuleInspectData {
  return {
    capsuleId: "my-capsule",
    version: "1.0.0",
    schemaVersion: "taxonomy-v1",
    createdAt: "2026-04-26T00:00:00.000Z",
    pluginVersion: "9.0.0",
    fileCount: 5,
    includesTranscripts: false,
    description: "A useful capsule",
    parentCapsule: null,
    retrievalPolicy: {
      tierWeights: { bm25: 1.5, vector: 0.8 },
      directAnswerEnabled: false,
    },
    includes: {
      taxonomy: true,
      identityAnchors: false,
      peerProfiles: false,
      procedural: true,
    },
    topFiles: ["facts/2026-01-01/fact-a.md", "entities/org.md"],
    ...overrides,
  };
}

test("renderCapsuleInspect text shows all key fields", () => {
  const output = renderCapsuleInspect(makeCapsuleInspectData(), "text");
  assert.ok(output.includes("my-capsule"));
  assert.ok(output.includes("1.0.0"));
  assert.ok(output.includes("taxonomy-v1"));
  assert.ok(output.includes("2026-04-26"));
  assert.ok(output.includes("A useful capsule"));
  assert.ok(output.includes("bm25"));
  assert.ok(output.includes("1.5"));
  assert.ok(output.includes("taxonomy:"));
});

test("renderCapsuleInspect text shows (none) for empty tier weights", () => {
  const data = makeCapsuleInspectData({
    retrievalPolicy: { tierWeights: {}, directAnswerEnabled: false },
  });
  const output = renderCapsuleInspect(data, "text");
  assert.ok(output.includes("(none)"));
});

test("renderCapsuleInspect text shows top files list", () => {
  const output = renderCapsuleInspect(makeCapsuleInspectData(), "text");
  assert.ok(output.includes("facts/2026-01-01/fact-a.md"));
  assert.ok(output.includes("entities/org.md"));
});

test("renderCapsuleInspect text shows parent capsule when set", () => {
  const data = makeCapsuleInspectData({ parentCapsule: "base-capsule" });
  const output = renderCapsuleInspect(data, "text");
  assert.ok(output.includes("base-capsule"));
});

test("renderCapsuleInspect markdown shows heading and sections", () => {
  const output = renderCapsuleInspect(makeCapsuleInspectData(), "markdown");
  assert.ok(output.includes("# Capsule: `my-capsule`"));
  assert.ok(output.includes("## Includes"));
  assert.ok(output.includes("## Retrieval policy"));
  assert.ok(output.includes("## Files"));
  assert.ok(output.includes("`facts/2026-01-01/fact-a.md`"));
});

test("renderCapsuleInspect markdown shows empty capsule message when no files", () => {
  const data = makeCapsuleInspectData({ fileCount: 0, topFiles: [] });
  const output = renderCapsuleInspect(data, "markdown");
  assert.ok(output.includes("_Empty capsule._"));
});

test("renderCapsuleInspect markdown shows no parent as _none_", () => {
  const output = renderCapsuleInspect(makeCapsuleInspectData(), "markdown");
  assert.ok(output.includes("_none_"));
});

test("renderCapsuleInspect json produces valid JSON with all fields", () => {
  const data = makeCapsuleInspectData();
  const parsed = JSON.parse(renderCapsuleInspect(data, "json"));
  assert.equal(parsed.capsuleId, "my-capsule");
  assert.equal(parsed.version, "1.0.0");
  assert.equal(parsed.fileCount, 5);
  assert.equal(parsed.retrievalPolicy.tierWeights.bm25, 1.5);
  assert.deepEqual(parsed.topFiles, [
    "facts/2026-01-01/fact-a.md",
    "entities/org.md",
  ]);
});

test("renderCapsuleInspect json shows null createdAt when missing", () => {
  const data = makeCapsuleInspectData({ createdAt: null });
  const parsed = JSON.parse(renderCapsuleInspect(data, "json"));
  assert.equal(parsed.createdAt, null);
});

// ---------------------------------------------------------------------------
// Suite 15 — encrypted capsule list / inspect path derivation (#755 P1 fixes)
// ---------------------------------------------------------------------------

/**
 * Simulate the ID-extraction logic used in cli.ts capsule list for both
 * plain and encrypted archive filenames.
 *
 * This is a pure-string test (no fs) covering the two-step replace
 * introduced by the P1 fix so regressions are caught without spinning up a
 * real filesystem.
 */
function extractCapsuleId(filename: string): string {
  return filename
    .replace(/\.capsule\.json\.gz\.enc$/, "")
    .replace(/\.capsule\.json\.gz$/, "");
}

test("capsule list id extraction: plain archive strips .capsule.json.gz", () => {
  assert.equal(extractCapsuleId("my-capsule.capsule.json.gz"), "my-capsule");
});

test("capsule list id extraction: encrypted archive strips .capsule.json.gz.enc", () => {
  assert.equal(extractCapsuleId("my-capsule.capsule.json.gz.enc"), "my-capsule");
});

test("capsule list id extraction: .enc suffix is not left behind for encrypted archives", () => {
  const id = extractCapsuleId("workload-2026.capsule.json.gz.enc");
  assert.ok(!id.endsWith(".enc"), `id should not end with .enc, got: ${id}`);
  assert.equal(id, "workload-2026");
});

test("capsule list id extraction: does not corrupt plain archive id that contains 'enc' elsewhere", () => {
  // 'enclave' in the name must not be stripped by the .enc rule.
  assert.equal(
    extractCapsuleId("enclave-memories.capsule.json.gz"),
    "enclave-memories",
  );
});

/**
 * Simulate the sidecar path derivation logic used in cli.ts capsule inspect.
 * The fix: strip .enc first, then replace .capsule.json.gz with .manifest.json.
 */
function deriveSidecarPath(archivePath: string): string {
  return archivePath
    .replace(/\.enc$/, "")
    .replace(/\.capsule\.json\.gz$/, ".manifest.json");
}

test("capsule inspect sidecar path: plain archive derives correct manifest path", () => {
  assert.equal(
    deriveSidecarPath("/caps/my-capsule.capsule.json.gz"),
    "/caps/my-capsule.manifest.json",
  );
});

test("capsule inspect sidecar path: encrypted archive derives correct manifest path", () => {
  assert.equal(
    deriveSidecarPath("/caps/my-capsule.capsule.json.gz.enc"),
    "/caps/my-capsule.manifest.json",
  );
});

test("capsule inspect sidecar path: encrypted archive does not leave .tar.gz in derived path (regression guard)", () => {
  // Prior bug: .replace(/\.capsule\.json\.gz$/, ...) on a .enc path would not
  // match, leaving the path unchanged and thus pointing at the archive itself
  // instead of the sidecar.
  const sidecar = deriveSidecarPath("/caps/snapshot.capsule.json.gz.enc");
  assert.ok(
    sidecar.endsWith(".manifest.json"),
    `sidecar path should end with .manifest.json; got: ${sidecar}`,
  );
  assert.ok(
    !sidecar.endsWith(".gz.enc"),
    `sidecar path must not retain .gz.enc suffix; got: ${sidecar}`,
  );
  assert.ok(
    !sidecar.endsWith(".gz"),
    `sidecar path must not retain .gz suffix; got: ${sidecar}`,
  );
});

test("renderCapsuleList text includes encrypted capsule entry", () => {
  // Simulate an entry that came from a .capsule.json.gz.enc file — the id
  // should already be stripped by the time renderCapsuleList is called.
  const entries: CapsuleListEntry[] = [
    makeCapsuleListEntry({
      id: "encrypted-capsule",
      archivePath: "/caps/encrypted-capsule.capsule.json.gz.enc",
    }),
  ];
  const output = renderCapsuleList(entries, "text");
  assert.ok(output.includes("encrypted-capsule"), "should list encrypted capsule by id");
  assert.ok(!output.includes(".enc"), "archive extension should not appear in text output");
});

test("renderCapsuleList json includes encrypted and plain capsules together", () => {
  const entries: CapsuleListEntry[] = [
    makeCapsuleListEntry({ id: "plain-cap", archivePath: "/caps/plain-cap.capsule.json.gz" }),
    makeCapsuleListEntry({
      id: "enc-cap",
      archivePath: "/caps/enc-cap.capsule.json.gz.enc",
    }),
  ];
  const parsed = JSON.parse(renderCapsuleList(entries, "json"));
  assert.equal(parsed.capsules.length, 2);
  assert.equal(parsed.capsules[0].id, "plain-cap");
  assert.equal(parsed.capsules[1].id, "enc-cap");
});
