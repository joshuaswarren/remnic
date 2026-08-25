import test from "node:test";
import assert from "node:assert/strict";

import { parseConfig } from "@remnic/core/config";

test("parseConfig accepts and trims offlineSyncExcludes strings", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    offlineSyncExcludes: ["  state/**  ", "tmp/*.log"],
  });
  assert.deepEqual(cfg.offlineSyncExcludes, ["state/**", "tmp/*.log"]);
});

test("parseConfig defaults offlineSyncExcludes to [] when omitted", () => {
  const cfg = parseConfig({ openaiApiKey: "sk-test" });
  assert.deepEqual(cfg.offlineSyncExcludes, []);
});

test("parseConfig rejects non-array offlineSyncExcludes", () => {
  assert.throws(
    () =>
      parseConfig({
        openaiApiKey: "sk-test",
        offlineSyncExcludes: "not-an-array",
      }),
    /must be an array/,
  );
});

test("parseConfig rejects offlineSyncExcludes entries that are not non-empty strings", () => {
  assert.throws(
    () =>
      parseConfig({
        openaiApiKey: "sk-test",
        offlineSyncExcludes: [42],
      }),
    /non-empty glob strings/,
  );
  assert.throws(
    () =>
      parseConfig({
        openaiApiKey: "sk-test",
        offlineSyncExcludes: [""],
      }),
    /non-empty glob strings/,
  );
});

test("parseConfig rejects offlineSyncExcludes entries containing NUL bytes", () => {
  assert.throws(
    () =>
      parseConfig({
        openaiApiKey: "sk-test",
        offlineSyncExcludes: ["state/with\0nul"],
      }),
    /NUL/,
  );
});