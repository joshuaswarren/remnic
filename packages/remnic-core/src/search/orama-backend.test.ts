import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EmbedHelper } from "./embed-helper.js";
import { OramaBackend, resolveOramaCollectionDbFilePath } from "./orama-backend.js";
import type { PluginConfig } from "../types.js";

function noEmbedHelper(): EmbedHelper {
  return new EmbedHelper({} as PluginConfig);
}

async function writeMemoryFact(
  memoryDir: string,
  fileName: string,
  content: string,
): Promise<void> {
  await mkdir(path.join(memoryDir, "facts"), { recursive: true });
  await writeFile(path.join(memoryDir, "facts", fileName), content, "utf8");
}

async function createBackend(
  memoryDir: string,
  dbPath: string,
  cjkSegmentationEnabled?: boolean,
): Promise<OramaBackend> {
  const backend = new OramaBackend({
    dbPath,
    collection: "openclaw-engram",
    embedHelper: noEmbedHelper(),
    memoryDir,
    embeddingDimension: 4,
    cjkSegmentationEnabled,
  });
  assert.equal(await backend.probe(), true);
  await backend.update();
  return backend;
}

test("Orama collection filenames cannot escape dbPath", () => {
  const dbPath = path.join("/tmp", "remnic-orama-db");

  assert.equal(
    resolveOramaCollectionDbFilePath(dbPath, "openclaw-engram"),
    path.join(dbPath, "openclaw-engram.msp"),
  );
  for (const collection of [
    "../outside",
    "nested/name",
    "",
    ".hidden",
    "collection name",
  ]) {
    assert.throws(
      () => resolveOramaCollectionDbFilePath(dbPath, collection),
      /Invalid Orama collection/,
      collection,
    );
  }
});

test("Orama lexical search finds a Japanese fact with no embeddings, at parity with English (issue #2187)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-orama-cjk-"));
  try {
    await writeMemoryFact(
      root,
      "japanese-fact.md",
      "---\nid: mem-japanese-fact\n---\n東京都庁の所在地は新宿区にある。最寄り駅は都庁前駅だ。",
    );
    await writeMemoryFact(
      root,
      "english-fact.md",
      "---\nid: mem-english-fact\n---\nThe Tokyo Metropolitan Government Office is located in Shinjuku. The nearest station is Tochomae.",
    );

    const backend = await createBackend(root, path.join(root, "orama-db"));

    const japanese = await backend.bm25Search("東京都庁の所在地");
    const english = await backend.bm25Search("Tokyo Metropolitan Government Office location");

    assert.equal(japanese.some((r) => r.docid === "mem-japanese-fact"), true);
    assert.equal(english.some((r) => r.docid === "mem-english-fact"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Orama CJK tokenizer rebuilds stale pre-CJK indexes on first open (issue #2187)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-orama-rebuild-"));
  try {
    await writeMemoryFact(
      root,
      "japanese-fact.md",
      "---\nid: mem-japanese-fact\n---\n東京都庁の所在地は新宿区にある。",
    );
    await writeMemoryFact(
      root,
      "english-fact.md",
      "---\nid: mem-english-fact\n---\nNebula-472 deploy finished in production.",
    );

    // Phase 1: index with the pre-CJK stock tokenizer (marker "english").
    const legacyBackend = await createBackend(root, path.join(root, "orama-db"), false);
    const legacyJapanese = await legacyBackend.bm25Search("東京都庁の所在地");
    assert.equal(
      legacyJapanese.some((r) => r.docid === "mem-japanese-fact"),
      false,
      "stock tokenizer must not match Japanese phrases",
    );
    const legacyEnglish = await legacyBackend.bm25Search("Nebula-472 deploy");
    assert.equal(legacyEnglish.some((r) => r.docid === "mem-english-fact"), true);

    // Phase 2: reopen with CJK segmentation on — the stale marker triggers an
    // in-place rebuild without any update() call.
    const rebuiltBackend = await createBackend(root, path.join(root, "orama-db"), true);
    const rebuiltJapanese = await rebuiltBackend.bm25Search("東京都庁の所在地");
    assert.equal(rebuiltJapanese.some((r) => r.docid === "mem-japanese-fact"), true);

    // English-corpus behavior is unchanged by the rebuild.
    const rebuiltEnglish = await rebuiltBackend.bm25Search("Nebula-472 deploy");
    assert.equal(rebuiltEnglish.some((r) => r.docid === "mem-english-fact"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Orama English-only corpora are not re-indexed when the tokenizer version advances (issue #2187)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-orama-english-"));
  try {
    await writeMemoryFact(
      root,
      "english-fact.md",
      "---\nid: mem-english-fact\n---\nNebula-472 deploy finished in production.",
    );

    const legacyBackend = await createBackend(root, path.join(root, "orama-db"), false);
    assert.equal(
      (await legacyBackend.bm25Search("Nebula-472 deploy")).some((r) => r.docid === "mem-english-fact"),
      true,
    );

    const upgradedBackend = await createBackend(root, path.join(root, "orama-db"), true);
    assert.equal(
      (await upgradedBackend.bm25Search("Nebula-472 deploy")).some((r) => r.docid === "mem-english-fact"),
      true,
      "English recall must survive the tokenizer upgrade",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
