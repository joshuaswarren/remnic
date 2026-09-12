import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import { parseSearchBackend } from "./config-search-backend.js";

test("#3097 parseSearchBackend rejects builtin and unknown values", () => {
  assert.equal(parseSearchBackend(undefined), "qmd");
  assert.equal(parseSearchBackend("qmd"), "qmd");
  assert.equal(parseSearchBackend("noop"), "noop");
  assert.throws(() => parseSearchBackend("builtin"), /must be one of: qmd, remote, noop, lancedb, meilisearch, orama/);
  assert.throws(() => parseSearchBackend("jsno"), /must be one of:/);
});

test("#3097 parseConfig rejects searchBackend=builtin instead of coercing", () => {
  assert.throws(() => parseConfig({ searchBackend: "builtin" }), /searchBackend must be one of/);
  const ok = parseConfig({ searchBackend: "orama" });
  assert.equal(ok.searchBackend, "orama");
});
