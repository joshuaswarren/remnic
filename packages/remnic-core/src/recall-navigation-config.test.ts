/**
 * Recall-navigation config parse (issue #1956 / PR #2937).
 *
 * Unknown keys fail closed. Default parse keeps navigation on and display
 * handles off, and that pair still records authority history.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "./config.js";
import {
  parseRecallNavigationConfig,
  RECALL_NAVIGATION_CONFIG_DEFAULTS,
  shouldRecordRecallAuthorityHistory,
} from "./recall-navigation-config.js";

test("parseRecallNavigationConfig rejects unknown keys instead of ignoring them", () => {
  assert.throws(
    () => parseRecallNavigationConfig({ windowSnapshot: 5 }),
    /recallNavigation contains unknown key "windowSnapshot"/,
  );
  assert.throws(
    () => parseConfig({ recallNavigation: { maxNeighbour: 4 } }),
    /unknown key "maxNeighbour"/,
  );
  assert.deepEqual(parseRecallNavigationConfig({}), RECALL_NAVIGATION_CONFIG_DEFAULTS);
});

test("default config records authority history with handles off and navigation on", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-nav-defaults-"));
  try {
    const config = parseConfig({ memoryDir });
    assert.equal(config.recallMemoryHandles, false);
    assert.equal(config.recallNavigation.enabled, true);
    assert.equal(shouldRecordRecallAuthorityHistory(config), true);
    assert.equal(
      shouldRecordRecallAuthorityHistory({
        recallMemoryHandles: false,
        recallNavigation: { enabled: false },
      }),
      false,
    );
    assert.equal(
      shouldRecordRecallAuthorityHistory({
        recallMemoryHandles: true,
        recallNavigation: { enabled: false },
      }),
      true,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
