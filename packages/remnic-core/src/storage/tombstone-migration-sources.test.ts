import * as assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createTombstoneMigrationSourceContents } from "./tombstone-migration-sources.js";
import type { MemoryFile } from "../types.js";

function memory(id: string, content: string): MemoryFile {
  return {
    path: `facts/${id}.md`,
    rawContent: content,
    frontmatter: { id, category: "fact", status: "active" },
  } as unknown as MemoryFile;
}

interface Harness {
  dir: string;
  ledgerPath: string;
  collectCalls: number;
  readsByPaths: string[][];
  gateCollect: Promise<void>;
  releaseCollect: () => void;
}

async function makeHarness(): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), "tomb-migration-race-"));
  const ledgerPath = path.join(dir, "tombstones.jsonl");
  await writeFile(ledgerPath, "", "utf8");
  let gateCollect: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    gateCollect = resolve;
  });
  const harness: Harness = {
    dir,
    ledgerPath,
    collectCalls: 0,
    readsByPaths: [],
    gateCollect: gate,
    releaseCollect: () => gateCollect?.(),
  };
  return harness;
}

test("an in-flight fill does not publish a stale cache after the ledger advances", async () => {
  const h = await makeHarness();
  try {
    const generations: string[][] = [["facts/old-a.md"], ["facts/new-a.md", "facts/old-a.md"]];
    const contents = new Map<string, string>([
      ["facts/old-a.md", "old body"],
      ["facts/new-a.md", "new body"],
    ]);
    const sourceContents = createTombstoneMigrationSourceContents({
      tombstonesPath: () => h.ledgerPath,
      collectTombstoneMigrationPaths: async () => {
        const callIndex = h.collectCalls + 1;
        h.collectCalls = callIndex;
        if (callIndex === 1) {
          // First fill stalls while a peer retires a legacy memory; the
          // generation is bound at call entry so the stall cannot upgrade
          // it to the fresh revision.
          await h.gateCollect;
        }
        return generations[Math.min(callIndex - 1, generations.length - 1)]!;
      },
      readParsedMemoriesFromPaths: async (filePaths: string[]) => {
        h.readsByPaths.push([...filePaths]);
        return filePaths
          .filter((filePath) => contents.has(filePath))
          .map((filePath) => memory(path.basename(filePath, ".md"), contents.get(filePath)!));
      },
      storedContentIdentityCandidates: (content: string) => [content],
    });

    // The first callback requests an id whose path exists only in the new
    // ledger revision, so a stale snapshot would miss it entirely.
    const first = sourceContents(["new-a"]);
    // Advance the ledger mtime so a later callback drops both caches while
    // the first fill is still awaiting its (stale) path snapshot.
    await utimes(h.ledgerPath, new Date(), new Date(Date.now() + 5000));
    const second = sourceContents(["old-a"]);
    h.releaseCollect();

    // Without the revision guard, the first callback would miss on the
    // stale snapshot, publish a full map built from it, and resolve empty.
    const firstResult = await first;
    assert.deepEqual([...firstResult.keys()], ["new-a"]);
    const secondResult = await second;
    assert.deepEqual([...secondResult.keys()], ["old-a"]);
    assert.equal(h.collectCalls >= 2, true, "restart re-collects paths against the fresh revision");
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});

test("a stable ledger revision reuses the collected paths across callbacks", async () => {
  const h = await makeHarness();
  try {
    const sourceContents = createTombstoneMigrationSourceContents({
      tombstonesPath: () => h.ledgerPath,
      collectTombstoneMigrationPaths: async () => {
        h.collectCalls += 1;
        return ["facts/a.md"];
      },
      readParsedMemoriesFromPaths: async (filePaths: string[]) =>
        filePaths.map((filePath) => memory(path.basename(filePath, ".md"), "body")),
      storedContentIdentityCandidates: (content: string) => [content],
    });
    await sourceContents(["a"]);
    await sourceContents(["a"]);
    assert.equal(h.collectCalls, 1, "unchanged ledger mtime reuses the path snapshot");
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});
