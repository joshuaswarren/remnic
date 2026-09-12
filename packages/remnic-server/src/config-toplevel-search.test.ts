import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "@remnic/core";
import { loadConfigFile } from "./index.js";

async function writeConfig(content: string): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-server-toplevel-search-"));
  const filePath = path.join(dir, "config.json");
  await writeFile(filePath, content, "utf-8");
  return { filePath, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("#3096 top-level-only qmdEnabled/searchBackend do not resolve to noop", async () => {
  const { filePath, cleanup } = await writeConfig(
    JSON.stringify({
      qmdEnabled: true,
      searchBackend: "qmd",
    }),
  );
  try {
    const loaded = loadConfigFile(filePath);
    const parsed = parseConfig(loaded.remnic);
    assert.equal(parsed.searchBackend, "qmd");
    assert.equal(parsed.qmdEnabled, true);
  } finally {
    await cleanup();
  }
});

test("#3096 nested remnic.searchBackend wins over a conflicting top-level key", async () => {
  const { filePath, cleanup } = await writeConfig(
    JSON.stringify({
      searchBackend: "qmd",
      qmdEnabled: true,
      remnic: { searchBackend: "noop", qmdEnabled: false },
    }),
  );
  try {
    const loaded = loadConfigFile(filePath);
    const parsed = parseConfig(loaded.remnic);
    assert.equal(parsed.searchBackend, "noop");
    assert.equal(parsed.qmdEnabled, false);
  } finally {
    await cleanup();
  }
});
