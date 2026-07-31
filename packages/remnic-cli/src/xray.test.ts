import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RecallXraySnapshot } from "@remnic/core";

import { extractXrayRawArgs, runXrayCommand } from "./index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function minimalSnapshot(): RecallXraySnapshot {
  return {
    schemaVersion: "1",
    query: "what is my favorite editor?",
    snapshotId: "11111111-1111-1111-1111-111111111111",
    capturedAt: 1_700_000_000_000,
    tierExplain: null,
    results: [],
    appliedResultLimit: 0,
    appliedResults: [],
    headroomResults: [],
    filters: [],
    budget: { chars: 4096, used: 0 },
  };
}

type MockIo = {
  recallCalls: Array<{ query: string; namespace?: string; budget?: number }>;
  writeFileCalls: Array<{ filePath: string; data: string }>;
  stdoutLines: string[];
};

function makeIo(
  respond: (
    request: { query: string; namespace?: string; budget?: number },
  ) => {
    snapshotFound: boolean;
    snapshot?: RecallXraySnapshot;
  },
): {
  io: Parameters<typeof runXrayCommand>[1];
  mock: MockIo;
} {
  const mock: MockIo = {
    recallCalls: [],
    writeFileCalls: [],
    stdoutLines: [],
  };
  const io = {
    recallXray: async (request: {
      query: string;
      namespace?: string;
      budget?: number;
    }) => {
      mock.recallCalls.push(request);
      return respond(request);
    },
    writeFile: async (filePath: string, data: string) => {
      mock.writeFileCalls.push({ filePath, data });
    },
    stdout: (line: string) => {
      mock.stdoutLines.push(line);
    },
  };
  return { io, mock };
}

// ---------------------------------------------------------------------------
// extractXrayRawArgs — pure tokenizer
// ---------------------------------------------------------------------------

describe("extractXrayRawArgs", () => {
  it("joins positional tokens into a single query string", () => {
    const parsed = extractXrayRawArgs(["what", "editor", "do", "I", "use"]);
    assert.equal(parsed.rawQuery, "what editor do I use");
    assert.deepEqual(parsed.options, {});
  });

  it("extracts every supported value flag", () => {
    const parsed = extractXrayRawArgs([
      "what",
      "editor",
      "--format",
      "markdown",
      "--budget",
      "2048",
      "--namespace",
      "workspace-a",
      "--out",
      "/tmp/out.md",
    ]);
    assert.equal(parsed.rawQuery, "what editor");
    assert.deepEqual(parsed.options, {
      format: "markdown",
      budget: "2048",
      namespace: "workspace-a",
      out: "/tmp/out.md",
    });
  });

  it("preserves positional tokens that appear after flags", () => {
    const parsed = extractXrayRawArgs([
      "--format",
      "json",
      "what",
      "editor",
    ]);
    assert.equal(parsed.rawQuery, "what editor");
    assert.deepEqual(parsed.options, { format: "json" });
  });

  it("rejects unknown flags with a listed-options error (rule 51)", () => {
    assert.throws(
      () => extractXrayRawArgs(["q", "--bogus", "v"]),
      /Unknown flag "--bogus"/,
    );
  });

  it("rejects --format with no following value (rule 14)", () => {
    assert.throws(
      () => extractXrayRawArgs(["q", "--format"]),
      /--format requires a value/,
    );
  });

  it("rejects --budget when the following token is another --flag (rule 14)", () => {
    assert.throws(
      () => extractXrayRawArgs(["q", "--budget", "--format", "json"]),
      /--budget requires a value/,
    );
  });

  it("rejects --namespace with no following value", () => {
    assert.throws(
      () => extractXrayRawArgs(["q", "--namespace"]),
      /--namespace requires a value/,
    );
  });

  it("rejects --out with no following value", () => {
    assert.throws(
      () => extractXrayRawArgs(["q", "--out"]),
      /--out requires a value/,
    );
  });
});

// ---------------------------------------------------------------------------
// runXrayCommand — full handler with mocked orchestrator
// ---------------------------------------------------------------------------

describe("runXrayCommand", () => {
  it("rejects an empty query (rule 51 via parseXrayCliOptions)", async () => {
    const { io } = makeIo(() => ({ snapshotFound: false }));
    await assert.rejects(
      () => runXrayCommand([], io),
      /xray: <query> is required and must be non-empty/,
    );
  });

  it("fail-fast: validation errors throw before recallXray is called (Codex P2 on #643)", async () => {
    const { io, mock } = makeIo(() => ({ snapshotFound: false }));
    // All four failure modes must short-circuit BEFORE the recall IO
    // fires, so `cmdXray`'s fail-fast guard (which calls the same
    // validators ahead of orchestrator bootstrap) is protected by
    // parity with this test.
    await assert.rejects(() => runXrayCommand([], io));
    await assert.rejects(() => runXrayCommand(["q", "--format", "xml"], io));
    await assert.rejects(() => runXrayCommand(["q", "--budget", "0"], io));
    await assert.rejects(() => runXrayCommand(["q", "--format"], io));
    assert.equal(
      mock.recallCalls.length,
      0,
      "recallXray must not be invoked when arg validation fails",
    );
  });

  it("rejects an unknown --format value", async () => {
    const { io } = makeIo(() => ({ snapshotFound: false }));
    await assert.rejects(
      () => runXrayCommand(["hello", "--format", "xml"], io),
      /--format expects one of json, text, markdown/,
    );
  });

  it("rejects a non-positive --budget value", async () => {
    const { io } = makeIo(() => ({ snapshotFound: false }));
    await assert.rejects(
      () => runXrayCommand(["hello", "--budget", "0"], io),
      /--budget expects a positive integer/,
    );
  });

  it("prints the text renderer output to stdout by default", async () => {
    const snap = minimalSnapshot();
    const { io, mock } = makeIo(() => ({
      snapshotFound: true,
      snapshot: snap,
    }));
    await runXrayCommand(["what", "editor"], io);
    assert.equal(mock.recallCalls.length, 1);
    assert.equal(mock.recallCalls[0].query, "what editor");
    assert.equal(mock.stdoutLines.length, 1);
    // Golden-style assertion: the rendered text prefix matches the
    // renderer contract in recall-xray-renderer.ts.
    assert.ok(mock.stdoutLines[0].startsWith("=== Recall X-ray ==="));
    assert.ok(mock.stdoutLines[0].includes(`query: ${snap.query}`));
    assert.equal(mock.writeFileCalls.length, 0);
  });

  it("renders JSON when --format json is passed", async () => {
    const snap = minimalSnapshot();
    const { io, mock } = makeIo(() => ({
      snapshotFound: true,
      snapshot: snap,
    }));
    await runXrayCommand(["hello", "--format", "json"], io);
    assert.equal(mock.stdoutLines.length, 1);
    const parsed = JSON.parse(mock.stdoutLines[0]);
    assert.equal(parsed.snapshotFound, true);
    assert.equal(parsed.schemaVersion, "1");
    assert.equal(parsed.query, snap.query);
  });

  it("emits the v1 not-found envelope when the service returns no snapshot", async () => {
    const { io, mock } = makeIo(() => ({ snapshotFound: false }));
    await runXrayCommand(["hello", "--format", "json"], io);
    assert.equal(mock.stdoutLines.length, 1);
    const parsed = JSON.parse(mock.stdoutLines[0]);
    assert.equal(parsed.snapshotFound, false);
    assert.equal(parsed.schemaVersion, "1");
  });

  it("threads --namespace and --budget through to recallXray", async () => {
    const snap = minimalSnapshot();
    const { io, mock } = makeIo(() => ({
      snapshotFound: true,
      snapshot: snap,
    }));
    await runXrayCommand(
      [
        "hello",
        "--namespace",
        "workspace-a",
        "--budget",
        "2048",
      ],
      io,
    );
    assert.equal(mock.recallCalls.length, 1);
    assert.equal(mock.recallCalls[0].namespace, "workspace-a");
    assert.equal(mock.recallCalls[0].budget, 2048);
  });

  it("writes to --out instead of stdout when the flag is set", async () => {
    const snap = minimalSnapshot();
    const { io, mock } = makeIo(() => ({
      snapshotFound: true,
      snapshot: snap,
    }));
    await runXrayCommand(
      [
        "hello",
        "--format",
        "markdown",
        "--out",
        "/tmp/xray-out.md",
      ],
      io,
    );
    assert.equal(mock.stdoutLines.length, 0);
    assert.equal(mock.writeFileCalls.length, 1);
    assert.equal(mock.writeFileCalls[0].filePath, "/tmp/xray-out.md");
    // Markdown output uses an H1 header per the renderer contract.
    assert.ok(mock.writeFileCalls[0].data.startsWith("# Recall X-ray"));
  });

  it("omits optional fields from the recall request when the flags are absent", async () => {
    const snap = minimalSnapshot();
    const { io, mock } = makeIo(() => ({
      snapshotFound: true,
      snapshot: snap,
    }));
    await runXrayCommand(["hello"], io);
    assert.equal(mock.recallCalls.length, 1);
    const request = mock.recallCalls[0];
    assert.equal(request.query, "hello");
    // namespace/budget should not be threaded through when absent so
    // access-service.ts can honor its own defaults.
    assert.equal("namespace" in request, false);
    assert.equal("budget" in request, false);
  });
});
