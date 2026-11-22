import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { configPathCandidates, discoverConfigPath } from "./config-discovery.js";

const ORIGINAL_ENV = {
  HOME: process.env.HOME,
  REMNIC_CONFIG_PATH: process.env.REMNIC_CONFIG_PATH,
  ENGRAM_CONFIG_PATH: process.env.ENGRAM_CONFIG_PATH,
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

test("env config paths expand every home-reference form on both surfaces", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-discovery-home-"));
  try {
    process.env.HOME = home;
    delete process.env.ENGRAM_CONFIG_PATH;
    const expected = path.join(home, "opt", "remnic.json");
    for (const form of ["$HOME/opt/remnic.json", "${HOME}/opt/remnic.json", "~/opt/remnic.json"]) {
      process.env.REMNIC_CONFIG_PATH = form;
      assert.equal(configPathCandidates()[0], expected, `configPathCandidates: ${form}`);
      assert.equal(discoverConfigPath().path, expected, `discoverConfigPath: ${form}`);
      assert.equal(discoverConfigPath().explicit, true, `explicit: ${form}`);
    }
  } finally {
    restoreEnv();
    await rm(home, { recursive: true, force: true });
  }
});
test("no env override leaves auto-discovery candidates only", () => {
  try {
    delete process.env.REMNIC_CONFIG_PATH;
    delete process.env.ENGRAM_CONFIG_PATH;
    const candidates = configPathCandidates();
    assert.equal(candidates[0], path.join(process.cwd(), "remnic.config.json"));
    assert.ok(!candidates[0].includes("$HOME"));
  } finally {
    restoreEnv();
  }
});
