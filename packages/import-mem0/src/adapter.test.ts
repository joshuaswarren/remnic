import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ImportTurn, ImporterWriteTarget } from "@remnic/core";
import { runImporter } from "@remnic/core";

import { adapter, mem0Adapter, setMem0ClientOptionsForTesting } from "./adapter.js";

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures",
);

function loadFixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), "utf-8");
}

function makeTarget(): {
  target: ImporterWriteTarget;
  received: ImportTurn[][];
} {
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

describe("mem0 adapter shape", () => {
  afterEach(() => {
    setMem0ClientOptionsForTesting(undefined);
    delete process.env.MEM0_API_KEY;
  });

  it("exports a canonical adapter + alias", () => {
    assert.equal(adapter.name, "mem0");
    assert.equal(adapter.sourceLabel, "mem0");
    assert.equal(mem0Adapter, adapter);
  });

  it("drives runImporter end-to-end with a replay fixture (no network)", async () => {
    const { target, received } = makeTarget();
    const result = await runImporter(
      adapter,
      loadFixture("replay-dump.json"),
      target,
      { parseOptions: { filePath: "/tmp/mem0-replay.json" } },
    );
    assert.equal(result.memoriesPlanned, 3);
    assert.equal(result.memoriesWritten, 3);
    assert.equal(result.sourceLabel, "mem0");
    const allTurns = received.flat();
    for (const turn of allTurns) {
      assert.equal(turn.role, "user");
      assert.equal(turn.participantName, "mem0");
    }
  });

  it("drives runImporter via the paginated record/replay fetch", async () => {
    // Two-page recording → inject a replay fetch, simulate live-API mode.
    const raw = JSON.parse(loadFixture("two-page-recording.json")) as {
      pages: Array<{
        request: { url: string };
        results?: unknown[];
        next?: string | null;
      }>;
    };
    const byUrl = new Map(raw.pages.map((p) => [p.request.url, p]));
    const replayFetch = (async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const match = byUrl.get(url);
      if (!match) return new Response("not found", { status: 404 });
      return new Response(
        JSON.stringify({ results: match.results ?? [], next: match.next ?? null }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    setMem0ClientOptionsForTesting({
      apiKey: "synthetic-key",
      baseUrl: "https://api.mem0.test",
      fetchImpl: replayFetch,
    });

    const { target, received } = makeTarget();
    // Live-API path: pass input=undefined.
    const result = await runImporter(adapter, undefined, target);
    assert.equal(result.memoriesPlanned, 3);
    assert.equal(result.memoriesWritten, 3);
    const allTurns = received.flat();
    assert.equal(allTurns.length, 3);
  });

  it("throws a user-facing error when no apiKey is available", async () => {
    delete process.env.MEM0_API_KEY;
    const { target } = makeTarget();
    await assert.rejects(
      () => runImporter(adapter, undefined, target),
      /API key/,
    );
  });

  it("dry-run does not hit the target", async () => {
    const { target, received } = makeTarget();
    const result = await runImporter(
      adapter,
      loadFixture("replay-dump.json"),
      target,
      { dryRun: true },
    );
    assert.equal(result.dryRun, true);
    assert.equal(received.length, 0);
  });

  // Cursor review on PR #602 — `--rate-limit` must reach fetchAllMem0Memories,
  // not be silently dropped after parse validation.
  it("forwards --rate-limit through runImporter to the fetch client", async () => {
    const raw = JSON.parse(loadFixture("two-page-recording.json")) as {
      pages: Array<{
        request: { url: string };
        results?: unknown[];
        next?: string | null;
      }>;
    };
    const byUrl = new Map(raw.pages.map((p) => [p.request.url, p]));
    const replayFetch = (async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const match = byUrl.get(url);
      if (!match) return new Response("not found", { status: 404 });
      return new Response(
        JSON.stringify({ results: match.results ?? [], next: match.next ?? null }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const sleeps: number[] = [];
    setMem0ClientOptionsForTesting({
      apiKey: "synthetic-key",
      baseUrl: "https://api.mem0.test",
      fetchImpl: replayFetch,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });

    const { target } = makeTarget();
    await runImporter(adapter, undefined, target, { rateLimit: 2 });
    // With rateLimit=2 (500ms interval) across a 2-page walk → exactly
    // one sleep between page 1 and page 2. If the CLI flag were dropped
    // (the bug), no sleeps would occur.
    assert.equal(sleeps.length, 1);
    assert.equal(sleeps[0], 500);
  });
});
