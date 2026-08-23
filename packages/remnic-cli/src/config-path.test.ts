import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveConfigPath } from "./config-path.js";
import {
  loadConvergeCommandConfig,
  resolveMemoryDir,
  resolveSyncSourceDir,
} from "./index.js";

const ORIGINAL_ENV = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  REMNIC_CONFIG_PATH: process.env.REMNIC_CONFIG_PATH,
  ENGRAM_CONFIG_PATH: process.env.ENGRAM_CONFIG_PATH,
  OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
  OPENCLAW_ENGRAM_CONFIG_PATH: process.env.OPENCLAW_ENGRAM_CONFIG_PATH,
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

test("resolveMemoryDir preserves flat fallback keys under a partial remnic block", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-memory-mixed-config-"));
  try {
    process.env.HOME = home;
    delete process.env.REMNIC_MEMORY_DIR;
    delete process.env.ENGRAM_MEMORY_DIR;
    delete process.env.ENGRAM_CONFIG_PATH;
    process.env.REMNIC_CONFIG_PATH = path.join(home, "remnic.json");
    await writeFile(
      process.env.REMNIC_CONFIG_PATH,
      JSON.stringify({
        memoryDir: "${HOME}/configured-memory",
        remnic: { wearables: { enabled: false } },
        server: { principal: "fleet" },
      }),
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

test("converge loads a plugin-scoped manual conflict policy", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-converge-openclaw-"));
  const openclawConfigPath = path.join(home, "openclaw.json");
  try {
    process.env.HOME = home;
    delete process.env.REMNIC_CONFIG_PATH;
    delete process.env.ENGRAM_CONFIG_PATH;
    process.env.OPENCLAW_CONFIG_PATH = openclawConfigPath;
    delete process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
    await writeFile(
      openclawConfigPath,
      JSON.stringify({
        plugins: {
          slots: { memory: "openclaw-remnic" },
          entries: {
            "openclaw-remnic": {
              config: { converge: { conflictPolicy: "manual" } },
            },
          },
        },
      }),
    );

    assert.equal(
      loadConvergeCommandConfig().converge.conflictPolicy,
      "manual",
    );
  } finally {
    restoreEnv();
    await rm(home, { recursive: true, force: true });
  }
});

test("converge honors an explicit standalone config path", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-converge-standalone-"));
  const openclawConfigPath = path.join(home, "openclaw.json");
  const standaloneConfigPath = path.join(home, "remnic.json");
  try {
    process.env.HOME = home;
    process.env.REMNIC_CONFIG_PATH = standaloneConfigPath;
    delete process.env.ENGRAM_CONFIG_PATH;
    process.env.OPENCLAW_CONFIG_PATH = openclawConfigPath;
    delete process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
    await writeFile(
      standaloneConfigPath,
      JSON.stringify({ converge: { conflictPolicy: "newest-wins" } }),
    );
    await writeFile(
      openclawConfigPath,
      JSON.stringify({
        plugins: {
          entries: {
            "openclaw-remnic": {
              config: { converge: { conflictPolicy: "manual" } },
            },
          },
        },
      }),
    );

    assert.equal(
      loadConvergeCommandConfig().converge.conflictPolicy,
      "newest-wins",
    );
  } finally {
    restoreEnv();
    await rm(home, { recursive: true, force: true });
  }
});

test("converge falls back to standalone config when a plugin entry has no config", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-converge-openclaw-default-"));
  const openclawConfigPath = path.join(home, "openclaw.json");
  const standaloneConfigPath = path.join(home, ".config", "remnic", "config.json");
  try {
    process.env.HOME = home;
    delete process.env.REMNIC_CONFIG_PATH;
    delete process.env.ENGRAM_CONFIG_PATH;
    process.env.OPENCLAW_CONFIG_PATH = openclawConfigPath;
    delete process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
    await mkdir(path.dirname(standaloneConfigPath), { recursive: true });
    await writeFile(
      standaloneConfigPath,
      JSON.stringify({ converge: { conflictPolicy: "manual" } }),
    );
    await writeFile(
      openclawConfigPath,
      JSON.stringify({
        plugins: {
          entries: {
            "openclaw-remnic": { enabled: true },
          },
        },
      }),
    );

    assert.equal(
      loadConvergeCommandConfig().converge.conflictPolicy,
      "manual",
    );
    await writeFile(
      openclawConfigPath,
      JSON.stringify({
        plugins: {
          entries: {
            "openclaw-remnic": { config: null, enabled: true },
          },
        },
      }),
    );
    assert.equal(
      loadConvergeCommandConfig().converge.conflictPolicy,
      "manual",
    );
  } finally {
    restoreEnv();
    await rm(home, { recursive: true, force: true });
  }
});

test("converge rejects malformed OpenClaw JSON", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-converge-openclaw-malformed-"));
  const openclawConfigPath = path.join(home, "openclaw.json");
  try {
    process.env.HOME = home;
    delete process.env.REMNIC_CONFIG_PATH;
    delete process.env.ENGRAM_CONFIG_PATH;
    process.env.OPENCLAW_CONFIG_PATH = openclawConfigPath;
    delete process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
    await writeFile(openclawConfigPath, "{");

    assert.throws(
      () => loadConvergeCommandConfig(),
      /contains invalid JSON/,
    );
  } finally {
    restoreEnv();
    await rm(home, { recursive: true, force: true });
  }
});

test("converge surfaces an invalid plugin conflictPolicy instead of silently defaulting", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-converge-invalid-policy-"));
  const openclawConfigPath = path.join(home, "openclaw.json");
  try {
    process.env.HOME = home;
    delete process.env.REMNIC_CONFIG_PATH;
    delete process.env.ENGRAM_CONFIG_PATH;
    process.env.OPENCLAW_CONFIG_PATH = openclawConfigPath;
    delete process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
    await writeFile(
      openclawConfigPath,
      JSON.stringify({
        plugins: {
          entries: {
            "openclaw-remnic": { config: { converge: { conflictPolicy: "manul" } }, enabled: true },
          },
        },
      }),
    );
    assert.throws(() => loadConvergeCommandConfig());
  } finally {
    restoreEnv();
    await rm(home, { recursive: true, force: true });
  }
});
