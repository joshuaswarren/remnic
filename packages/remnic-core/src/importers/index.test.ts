// ---------------------------------------------------------------------------
// Runtime barrel purity (issue #2794, fix round)
// ---------------------------------------------------------------------------
// `makeImporterTestTarget` / `loadImporterFixture` live behind the
// `@remnic/core/importers/test-utils` subpath ONLY. A static re-export from
// this barrel would link test-utils.js — and its node:fs/node:path/node:url
// imports — into every production consumer of `@remnic/core/importers`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import * as barrel from "./index.js";

// Namespace record read is deliberate: the harness names must be ABSENT, so
// they cannot appear on the typed surface of the barrel.
const surface = barrel as Record<string, unknown>;

const barrelSource = readFileSync(
  new URL("./index.ts", import.meta.url),
  "utf-8",
);

test("runtime barrel does not export the test harness (#2794)", () => {
  assert.equal(
    surface.makeImporterTestTarget,
    undefined,
    "test harness must stay behind @remnic/core/importers/test-utils",
  );
  assert.equal(
    surface.loadImporterFixture,
    undefined,
    "test harness must stay behind @remnic/core/importers/test-utils",
  );
});

test("runtime barrel statically links no test-utils module (#2794)", () => {
  assert.ok(
    !barrelSource.includes("test-utils"),
    "src/importers/index.ts must not reference ./test-utils.js — import @remnic/core/importers/test-utils instead",
  );
});
