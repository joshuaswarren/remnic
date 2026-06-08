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

test("resolveConfigPath honors Pi agent directory overrides", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-config-roots-"));
  try {
    const home = path.join(root, "home");
    const codingAgentDir = path.join(root, "coding-agent");
    const agentHome = path.join(root, "agent-home");
    const piHome = path.join(root, "pi-home");

    assert.equal(
      resolveConfigPath({
        env: {
          HOME: home,
          PI_CODING_AGENT_DIR: codingAgentDir,
          PI_AGENT_HOME: path.join(root, "wrong-agent-home"),
          PI_HOME: path.join(root, "wrong-pi-home"),
        },
      }),
      path.join(codingAgentDir, "extensions", "remnic", "remnic.config.json"),
    );
    assert.equal(
      resolveConfigPath({ env: { HOME: home, PI_AGENT_HOME: agentHome } }),
      path.join(agentHome, "extensions", "remnic", "remnic.config.json"),
    );
    assert.equal(
      resolveConfigPath({ env: { HOME: home, PI_HOME: piHome } }),
      path.join(piHome, "agent", "extensions", "remnic", "remnic.config.json"),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveConfigPath expands tilde in explicit and env config paths", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-tilde-home-"));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = home;

    assert.equal(
      resolveConfigPath({ configPath: "~/custom/remnic.config.json", env: {} }),
      path.join(home, "custom", "remnic.config.json"),
    );
    assert.equal(
      resolveConfigPath({ env: { REMNIC_PI_CONFIG: "~/env/remnic.config.json" } }),
      path.join(home, "env", "remnic.config.json"),
    );
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("loadConfig reads a tilde-expanded env config path", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-tilde-load-"));
  const previousHome = process.env.HOME;
  const configPath = path.join(home, "env", "remnic.config.json");
  try {
    process.env.HOME = home;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ authToken: "remnic_pi_tilde" }));

    const config = loadConfig({ env: { REMNIC_PI_CONFIG: "~/env/remnic.config.json" } });

    assert.equal(config.authToken, "remnic_pi_tilde");
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("loadConfig defaults request timeout high enough for warmed-up recall", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-config-default-timeout-"));
  const configPath = path.join(root, "remnic.config.json");
  try {
    fs.writeFileSync(configPath, JSON.stringify({}));

    const config = loadConfig({ configPath, env: {} });

    assert.equal(config.requestTimeoutMs, 60000);
    assert.equal(config.startupRequestTimeoutMs, 1000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
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
        recallTopK: "50",
        requestTimeoutMs: "10",
        startupRequestTimeoutMs: "20",
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
    assert.equal(config.startupRequestTimeoutMs, 20);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig fails closed on malformed config files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-config-bad-"));
  const configPath = path.join(root, "remnic.config.json");
  try {
    fs.writeFileSync(configPath, "{not-json");

    assert.throws(
      () => loadConfig({ configPath, env: { REMNIC_DAEMON_URL: "http://127.0.0.1:5555" } }),
      /Failed to load Remnic Pi config/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig fails closed when config file is not an object", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-config-shape-"));
  const configPath = path.join(root, "remnic.config.json");
  try {
    fs.writeFileSync(configPath, "[]");

    assert.throws(
      () => loadConfig({ configPath, env: {} }),
      /expected a JSON object/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig fails closed on invalid boolean gate values", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-config-bool-"));
  const configPath = path.join(root, "remnic.config.json");
  try {
    fs.writeFileSync(configPath, JSON.stringify({ observeEnabled: "flase" }));

    assert.throws(
      () => loadConfig({ configPath, env: {} }),
      /Invalid boolean value for Remnic Pi config field observeEnabled/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig fails closed on invalid daemon URL values", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-config-daemon-"));
  const configPath = path.join(root, "remnic.config.json");
  try {
    fs.writeFileSync(configPath, JSON.stringify({ remnicDaemonUrl: 4318 }));
    assert.throws(
      () => loadConfig({ configPath, env: {} }),
      /Invalid URL value for Remnic Pi config field remnicDaemonUrl/,
    );

    fs.writeFileSync(configPath, JSON.stringify({ remnicDaemonUrl: "not-a-url" }));
    assert.throws(
      () => loadConfig({ configPath, env: {} }),
      /Invalid URL value for Remnic Pi config field remnicDaemonUrl/,
    );

    fs.writeFileSync(configPath, JSON.stringify({}));
    assert.throws(
      () => loadConfig({ configPath, env: { REMNIC_DAEMON_URL: "not-a-url" } }),
      /Invalid URL value for Remnic Pi config field REMNIC_DAEMON_URL/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig fails closed on invalid auth token values", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-config-token-"));
  const configPath = path.join(root, "remnic.config.json");
  try {
    fs.writeFileSync(configPath, JSON.stringify({ authToken: ["remnic_pi_token"] }));

    assert.throws(
      () => loadConfig({ configPath, env: {} }),
      /Invalid string value for Remnic Pi config field authToken/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig fails closed on invalid recall modes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-config-recall-mode-"));
  const configPath = path.join(root, "remnic.config.json");
  try {
    fs.writeFileSync(configPath, JSON.stringify({ recallMode: "no-recall" }));

    assert.throws(
      () => loadConfig({ configPath, env: {} }),
      /Invalid recallMode value for Remnic Pi config/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig fails closed on invalid numeric values", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-config-number-"));
  const configPath = path.join(root, "remnic.config.json");
  try {
    fs.writeFileSync(configPath, JSON.stringify({ recallTopK: "abc" }));
    assert.throws(
      () => loadConfig({ configPath, env: {} }),
      /Invalid numeric value for Remnic Pi config field recallTopK/,
    );

    fs.writeFileSync(configPath, JSON.stringify({ recallBudgetChars: 0 }));
    assert.throws(
      () => loadConfig({ configPath, env: {} }),
      /Invalid numeric value for Remnic Pi config field recallBudgetChars/,
    );

    fs.writeFileSync(configPath, JSON.stringify({ requestTimeoutMs: 10.5 }));
    assert.throws(
      () => loadConfig({ configPath, env: {} }),
      /Invalid numeric value for Remnic Pi config field requestTimeoutMs/,
    );

    fs.writeFileSync(configPath, JSON.stringify({ startupRequestTimeoutMs: "slow" }));
    assert.throws(
      () => loadConfig({ configPath, env: {} }),
      /Invalid numeric value for Remnic Pi config field startupRequestTimeoutMs/,
    );

    fs.writeFileSync(configPath, JSON.stringify({ recallTopK: true }));
    assert.throws(
      () => loadConfig({ configPath, env: {} }),
      /Invalid numeric value for Remnic Pi config field recallTopK/,
    );

    fs.writeFileSync(configPath, JSON.stringify({ recallTopK: [5] }));
    assert.throws(
      () => loadConfig({ configPath, env: {} }),
      /Invalid numeric value for Remnic Pi config field recallTopK/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig fails closed on invalid namespace values", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-config-namespace-"));
  const configPath = path.join(root, "remnic.config.json");
  try {
    fs.writeFileSync(configPath, JSON.stringify({ namespace: ["work"] }));
    assert.throws(
      () => loadConfig({ configPath, env: {} }),
      /Invalid string value for Remnic Pi config field namespace/,
    );

    fs.writeFileSync(configPath, JSON.stringify({ namespace: "   " }));
    assert.throws(
      () => loadConfig({ configPath, env: {} }),
      /Invalid string value for Remnic Pi config field namespace/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
