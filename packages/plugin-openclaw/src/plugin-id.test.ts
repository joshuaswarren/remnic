import assert from "node:assert/strict";
import test from "node:test";
import { LEGACY_PLUGIN_ID, PLUGIN_ID } from "@remnic/core/plugin-id";
import {
  LEGACY_PLUGIN_ID as ADAPTER_LEGACY,
  PLUGIN_ID as ADAPTER_CANONICAL,
  REMNIC_OPENCLAW_LEGACY_PLUGIN_ID,
  REMNIC_OPENCLAW_PLUGIN_ID,
  REMNIC_OPENCLAW_PLUGIN_IDS,
} from "./plugin-id.js";

test("#2470 adapter plugin ids are re-exports of @remnic/core/plugin-id", () => {
  assert.equal(REMNIC_OPENCLAW_PLUGIN_ID, PLUGIN_ID);
  assert.equal(REMNIC_OPENCLAW_LEGACY_PLUGIN_ID, LEGACY_PLUGIN_ID);
  assert.equal(ADAPTER_CANONICAL, PLUGIN_ID);
  assert.equal(ADAPTER_LEGACY, LEGACY_PLUGIN_ID);
  assert.deepEqual(REMNIC_OPENCLAW_PLUGIN_IDS, [PLUGIN_ID, LEGACY_PLUGIN_ID]);
});
