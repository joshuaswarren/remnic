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
  options: { update?: boolean } = {},
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
  if (options.update !== false) {
    await backend.update();
  }
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
      "russian-fact.md",
      "---\nid: mem-russian-fact\n---\nПравительство Токио находится в Синдзюку.",
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

    // Phase 2: reopen with CJK segmentation on and NO update() call — the
    // stale marker alone must trigger the in-place rebuild during probe().
    const rebuiltBackend = await createBackend(root, path.join(root, "orama-db"), true, {
      update: false,
    });
    const rebuiltJapanese = await rebuiltBackend.bm25Search("東京都庁の所在地");
    assert.equal(rebuiltJapanese.some((r) => r.docid === "mem-japanese-fact"), true);

    // Non-CJK non-Latin scripts are re-indexed too (whole-word terms), not
    // just CJK/Thai.
    const rebuiltRussian = await rebuiltBackend.bm25Search("Правительство Токио");
    assert.equal(rebuiltRussian.some((r) => r.docid === "mem-russian-fact"), true);

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

test("Orama downgrades persisted CJK indexes when segmentation is disabled (issue #2187)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-orama-downgrade-"));
  try {
    await writeMemoryFact(
      root,
      "japanese-fact.md",
      "---\nid: mem-japanese-fact\n---\n東京都庁の所在地は新宿区にある。",
    );

    // Phase 1: index with CJK segmentation on (marker "english+cjk-v1").
    const cjkBackend = await createBackend(root, path.join(root, "orama-db"), true);
    assert.equal(
      (await cjkBackend.bm25Search("東京都庁の所在地")).some((r) => r.docid === "mem-japanese-fact"),
      true,
      "CJK tokenizer must match Japanese phrases before the downgrade",
    );

    // Phase 2: reopen with segmentation disabled and NO update() call — the
    // persisted CJK marker alone must trigger the stock re-index.
    const downgraded = await createBackend(root, path.join(root, "orama-db"), false, {
      update: false,
    });
    assert.equal(
      (await downgraded.bm25Search("東京都庁の所在地")).some((r) => r.docid === "mem-japanese-fact"),
      false,
      "stock tokenizer must not match Japanese phrases after the downgrade",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Orama rebuild gate inspects every indexed string field, not only content (issue #2187)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-orama-pathfield-"));
  try {
    // The only non-Latin text is the FILENAME, which lands in the indexed
    // path field; the body is pure English.
    await writeMemoryFact(
      root,
      "東京-fact.md",
      "---\nid: mem-path-only\n---\nAn English body with no non-Latin characters.",
    );

    // Phase 1: pre-CJK stock index — the CJK filename never becomes a term.
    const legacyBackend = await createBackend(root, path.join(root, "orama-db"), false);
    assert.equal(
      (await legacyBackend.bm25Search("東京")).some((r) => r.docid === "mem-path-only"),
      false,
      "stock tokenizer must not match the CJK filename",
    );

    // Phase 2: reopen with segmentation on and NO update() call — the
    // path field alone must gate the in-place re-index.
    const rebuilt = await createBackend(root, path.join(root, "orama-db"), true, {
      update: false,
    });
    assert.equal(
      (await rebuilt.bm25Search("東京")).some((r) => r.docid === "mem-path-only"),
      true,
      "non-Latin text in the path field must gate the rebuild",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
