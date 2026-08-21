import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  LEGACY_PLUGIN_ID,
  PLUGIN_ID,
  resolveRemnicPluginEntry,
} from "./plugin-id.js";

test("plugin-id compatibility subpath exposes canonical ids and resolver", () => {
  assert.equal(PLUGIN_ID, "openclaw-remnic");
  assert.equal(LEGACY_PLUGIN_ID, "openclaw-engram");

  const entry = resolveRemnicPluginEntry(
    {
      plugins: {
        entries: {
          "openclaw-remnic": { config: { memoryDir: "/tmp/remnic" } },
          "openclaw-engram": { config: { memoryDir: "/tmp/engram" } },
        },
      },
    },
    LEGACY_PLUGIN_ID,
  );

  assert.deepEqual(entry, { config: { memoryDir: "/tmp/engram" } });
});

test("package exports preserve plugin-id compatibility subpaths", async () => {
  const packageJsonUrl = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(await readFile(packageJsonUrl, "utf8")) as {
    exports?: Record<string, unknown>;
  };

  assert.ok(pkg.exports?.["./plugin-id"]);
  assert.ok(pkg.exports?.["./plugin-id.js"]);
});
