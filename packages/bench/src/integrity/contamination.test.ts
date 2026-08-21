import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_CONTAMINATION_MANIFEST,
  addContaminationEntry,
  checkDatasetContamination,
  isContaminationEntry,
  isContaminationManifest,
  mergeContaminationManifests,
  type ContaminationEntry,
  type ContaminationManifest,
} from "./contamination.ts";
import { hashString } from "./hash-verification.ts";

function makeEntry(text: string): ContaminationEntry {
  return {
    datasetHash: hashString(text),
    reason: `test entry for ${text}`,
    reference: "https://example.invalid/report",
    addedAt: "2026-04-18T00:00:00.000Z",
  };
}

test("empty manifest returns clean for any dataset hash", () => {
  const result = checkDatasetContamination(hashString("clean"), EMPTY_CONTAMINATION_MANIFEST);
  assert.equal(result.clean, true);
  assert.equal(result.matched, undefined);
});

test("checkDatasetContamination flags matching hashes", () => {
  const entry = makeEntry("dirty");
  const manifest: ContaminationManifest = {
    version: 1,
    entries: [entry],
  };
  const result = checkDatasetContamination(entry.datasetHash, manifest);
  assert.equal(result.clean, false);
  assert.equal(result.matched?.datasetHash, entry.datasetHash);
});

test("checkDatasetContamination rejects malformed hashes", () => {
  assert.throws(() => checkDatasetContamination("not-a-hash"));
});

test("isContaminationEntry validates structural requirements", () => {
  assert.ok(isContaminationEntry(makeEntry("ok")));
  assert.ok(!isContaminationEntry({ datasetHash: "short", reason: "r", addedAt: "" }));
  assert.ok(!isContaminationEntry({ datasetHash: hashString("x"), addedAt: "now" }));
});

test("addContaminationEntry deduplicates on datasetHash", () => {
  const first = makeEntry("x");
  const manifest = addContaminationEntry(EMPTY_CONTAMINATION_MANIFEST, first);
  const duplicate = { ...first, reason: "different reason" };
  const result = addContaminationEntry(manifest, duplicate);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]?.reason, "test entry for x");
});

test("addContaminationEntry rejects invalid entries", () => {
  assert.throws(() =>
    addContaminationEntry(EMPTY_CONTAMINATION_MANIFEST, {
      datasetHash: "nope",
      reason: "",
      addedAt: "",
    } as ContaminationEntry),
  );
});

test("mergeContaminationManifests combines manifests and dedupes", () => {
  const a = { version: 1 as const, entries: [makeEntry("a"), makeEntry("shared")] };
  const b = { version: 1 as const, entries: [makeEntry("shared"), makeEntry("b")] };
  const merged = mergeContaminationManifests(a, b);
  assert.equal(merged.entries.length, 3);
});

test("isContaminationManifest validates version and entry shape", () => {
  assert.ok(isContaminationManifest(EMPTY_CONTAMINATION_MANIFEST));
  assert.ok(!isContaminationManifest({ version: 1, entries: "bad" }));
  assert.ok(!isContaminationManifest({ version: 2, entries: [] }));
});
