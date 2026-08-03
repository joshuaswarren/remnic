import test from "node:test";
import assert from "node:assert/strict";
import { selectArtifactMatches, tokenizeArtifactSearchText } from "./artifact-search.js";
import type { MemoryFile } from "./types.js";

function artifact(id: string, content: string, tags: string[] = []): MemoryFile {
  return {
    path: `artifacts/${id}.md`,
    content,
    frontmatter: {
      id,
      category: "artifact",
      created: "2026-08-01T00:00:00.000Z",
      updated: "2026-08-01T00:00:00.000Z",
      ...(tags.length > 0 ? { tags } : {}),
    },
  } as unknown as MemoryFile;
}

test("artifact scan ranks by query token overlap and applies the result cap", async () => {
  const matches = await selectArtifactMatches(
    async () => [
      artifact("a", "the deploy runbook covers rollback"),
      artifact("b", "unrelated grocery list"),
      artifact("c", "runbook", ["deploy", "rollback"]),
    ],
    "deploy rollback runbook",
    2,
  );

  assert.deepEqual(
    matches.map((m) => m.frontmatter.id),
    ["a", "c"],
  );
});

test("a stopword-only query never reads the artifact tier", async () => {
  // Reading the tier is a full recursive filesystem scan on a cold cache, so a
  // query that cannot match anything must not pay for it (issue #2291).
  let loaded = 0;
  const matches = await selectArtifactMatches(
    async () => {
      loaded += 1;
      return [artifact("a", "the and of")];
    },
    "the and of",
    5,
  );

  assert.deepEqual(matches, []);
  assert.equal(loaded, 0);
});

test("an already-aborted caller never reads the artifact tier", async () => {
  const aborted = new AbortController();
  aborted.abort();
  let loaded = 0;

  await assert.rejects(
    selectArtifactMatches(
      async () => {
        loaded += 1;
        return [artifact("a", "deploy runbook")];
      },
      "deploy runbook",
      5,
      { abortSignal: aborted.signal },
    ),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );
  assert.equal(loaded, 0);
});

test("artifact scan stops at the caller's signal instead of scanning the tier", async () => {
  // Yield/abort checkpoints land every 256 documents, so the corpus must cross
  // that boundary for cancellation to be observable mid-scan (issue #2291).
  const artifacts = Array.from({ length: 600 }, (_unused, index) =>
    artifact(`doc-${index}`, "deploy runbook rollback"),
  );
  const aborted = new AbortController();
  let scannedBeforeAbort = 0;
  const artifactsWithProbe = artifacts.map((memory) => ({
    get content() {
      scannedBeforeAbort += 1;
      if (scannedBeforeAbort === 300) aborted.abort();
      return memory.content;
    },
    path: memory.path,
    frontmatter: memory.frontmatter,
  })) as unknown as MemoryFile[];

  await assert.rejects(
    selectArtifactMatches(async () => artifactsWithProbe, "deploy runbook", 5, {
      abortSignal: aborted.signal,
    }),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );
  assert.ok(
    scannedBeforeAbort < artifacts.length,
    `scan stopped early (read ${scannedBeforeAbort} of ${artifacts.length})`,
  );
});

test("artifact tokenizer drops stopwords and single characters", () => {
  assert.deepEqual(tokenizeArtifactSearchText("The a deploy-runbook v2"), [
    "deploy",
    "runbook",
    "v2",
  ]);
});
