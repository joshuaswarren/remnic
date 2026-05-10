import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig, resolveConfigPath } from "./config.js";

test("resolveConfigPath uses the Pi extension config location by default", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-home-"));
  try {
    assert.equal(
      resolveConfigPath({ env: { HOME: home } }),
      path.join(home, ".pi", "agent", "extensions", "remnic", "remnic.config.json"),
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("loadConfig merges file values and coerces boolean-like strings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-config-"));
  const configPath = path.join(root, "remnic.config.json");
  try {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        remnicDaemonUrl: "http://127.0.0.1:9999/",
        authToken: "remnic_pi_test",
        namespace: "work",
        recallEnabled: "false",
        observeSkipExtraction: "1",
        mcpToolsEnabled: "0",
        recallTopK: 500,
        requestTimeoutMs: 10,
      }),
    );

    const config = loadConfig({ configPath, env: {} });

    assert.equal(config.remnicDaemonUrl, "http://127.0.0.1:9999");
    assert.equal(config.authToken, "remnic_pi_test");
    assert.equal(config.namespace, "work");
    assert.equal(config.recallEnabled, false);
    assert.equal(config.observeSkipExtraction, true);
    assert.equal(config.mcpToolsEnabled, false);
    assert.equal(config.recallTopK, 50);
    assert.equal(config.requestTimeoutMs, 10);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
