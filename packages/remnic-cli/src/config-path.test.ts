import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveConfigPath, resolveMemoryDir, resolveSyncSourceDir } from "./index.js";

const ORIGINAL_ENV = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  REMNIC_CONFIG_PATH: process.env.REMNIC_CONFIG_PATH,
  ENGRAM_CONFIG_PATH: process.env.ENGRAM_CONFIG_PATH,
  REMNIC_MEMORY_DIR: process.env.REMNIC_MEMORY_DIR,
  ENGRAM_MEMORY_DIR: process.env.ENGRAM_MEMORY_DIR,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

test("resolveConfigPath expands home-relative CLI paths", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-config-home-"));
  try {
    process.env.HOME = home;
    delete process.env.REMNIC_CONFIG_PATH;
    delete process.env.ENGRAM_CONFIG_PATH;

    assert.equal(
      resolveConfigPath("~/remnic.json"),
      path.join(home, "remnic.json"),
    );
    assert.equal(
      resolveConfigPath("$HOME/remnic.json"),
      path.join(home, "remnic.json"),
    );
    assert.equal(
      resolveConfigPath("${HOME}/remnic.json"),
      path.join(home, "remnic.json"),
    );
  } finally {
    restoreEnv();
    await rm(home, { recursive: true, force: true });
  }
});

test("resolveMemoryDir expands home-relative env and config paths", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-memory-home-"));
  try {
    process.env.HOME = home;
    process.env.REMNIC_MEMORY_DIR = "~/memory";
    delete process.env.ENGRAM_MEMORY_DIR;
    delete process.env.ENGRAM_CONFIG_PATH;
    delete process.env.REMNIC_CONFIG_PATH;

    assert.equal(resolveMemoryDir(), path.join(home, "memory"));

    delete process.env.REMNIC_MEMORY_DIR;
    process.env.REMNIC_CONFIG_PATH = "~/remnic.json";
    await writeFile(
      path.join(home, "remnic.json"),
      JSON.stringify({ remnic: { memoryDir: "${HOME}/configured-memory" } }),
    );

    assert.equal(resolveMemoryDir(), path.join(home, "configured-memory"));
  } finally {
    restoreEnv();
    await rm(home, { recursive: true, force: true });
  }
});

test("resolveSyncSourceDir rejects bare source flags", () => {
  assert.equal(resolveSyncSourceDir([]), ".");
  assert.equal(resolveSyncSourceDir(["--source", "/tmp/source", "--json"]), "/tmp/source");
  assert.throws(
    () => resolveSyncSourceDir(["--source"]),
    /--source requires a value/,
  );
  assert.throws(
    () => resolveSyncSourceDir(["--source", "--json"]),
    /--source requires a value/,
  );
});

test("resolveConfigPath expands home-relative env config paths", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-config-home-"));
  try {
    process.env.HOME = home;
    process.env.REMNIC_CONFIG_PATH = "~/remnic.json";
    delete process.env.ENGRAM_CONFIG_PATH;

    assert.equal(resolveConfigPath(), path.join(home, "remnic.json"));

    delete process.env.REMNIC_CONFIG_PATH;
    process.env.ENGRAM_CONFIG_PATH = "${HOME}/engram.json";

    assert.equal(resolveConfigPath(), path.join(home, "engram.json"));
  } finally {
    restoreEnv();
    await rm(home, { recursive: true, force: true });
  }
});
