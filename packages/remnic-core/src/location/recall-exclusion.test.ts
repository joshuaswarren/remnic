import assert from "node:assert/strict";
import test from "node:test";

import { isSearchExcludedPath } from "../orchestration/generic-recall-paths.js";
import { isLocationDayPath } from "../orchestration/orchestrator-helpers.js";

const MEMORY_DIR = "/tmp/remnic-fixture-memory";

test("isLocationDayPath matches only the top-level day-file shape", () => {
  assert.equal(isLocationDayPath("locations/2026-08-17.md", MEMORY_DIR), true);
  assert.equal(isLocationDayPath(`${MEMORY_DIR}/locations/2026-08-17.md`, MEMORY_DIR), true);
  assert.equal(isLocationDayPath("facts/notes/locations.md", MEMORY_DIR), false);
  assert.equal(isLocationDayPath("facts/locations/2026-08-17.md", MEMORY_DIR), false, "nested stays recallable");
  assert.equal(isLocationDayPath("locations/2026-08-17.md"), true, "root-unaware best-effort fallback");
  assert.equal(isLocationDayPath("locations/not-a-date.md"), false);
});

test("isSearchExcludedPath keeps location day documents out of generic search and recall", () => {
  assert.equal(isSearchExcludedPath("locations/2026-08-17.md"), true);
  assert.equal(
    isSearchExcludedPath("qmd://collection/locations/2026-08-17.md", {}, "qmd"),
    true,
    "collection-qualified QMD paths are stripped and re-tested",
  );
  assert.equal(
    isSearchExcludedPath(`${MEMORY_DIR}/namespaces/team/locations/2026-08-17.md`, { memoryDir: MEMORY_DIR }),
    true,
    "a namespaced day document is excluded via the namespace root",
  );
  assert.equal(isSearchExcludedPath("facts/locations-tips.md"), false);
  assert.equal(
    isSearchExcludedPath("namespaces/locations/facts/a.md", { memoryDir: MEMORY_DIR }),
    false,
    "a namespace literally named locations keeps its memories recallable",
  );
});
