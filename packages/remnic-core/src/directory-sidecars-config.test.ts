import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import {
  applyDirectorySidecarDrillDown,
  isDirectorySidecarsEnabledForDir,
  setDirectorySidecarsEnabledForDir,
} from "./directory-sidecars.js";

test("#3088 parseConfig directorySidecarsEnabled is off by default and opt-in only", () => {
  assert.equal(parseConfig({}).directorySidecarsEnabled, false);
  assert.equal(parseConfig({ directorySidecarsEnabled: "false" }).directorySidecarsEnabled, false);
  assert.equal(parseConfig({ directorySidecarsEnabled: true }).directorySidecarsEnabled, true);
});

test("#3088 sidecar enable walks up from namespace storage roots", () => {
  const root = "/tmp/remnic-sidecar-root";
  const nested = `${root}/namespaces/team-a`;
  setDirectorySidecarsEnabledForDir(root, true);
  assert.equal(isDirectorySidecarsEnabledForDir(nested), true);
  setDirectorySidecarsEnabledForDir(nested, false);
  assert.equal(isDirectorySidecarsEnabledForDir(nested), false);
  assert.equal(isDirectorySidecarsEnabledForDir("/tmp/other-memory"), false);
});

test("#3088 drill-down skips when authorized namespace set is empty", async () => {
  const hits = [{ path: "facts/a.md", snippet: "hello", score: 1 }];
  const out = await applyDirectorySidecarDrillDown("/tmp/memory", "hello", hits, {
    enabled: true,
    namespaces: [],
  });
  assert.deepEqual(out, hits);
});
