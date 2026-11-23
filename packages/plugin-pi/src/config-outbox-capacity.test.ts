import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

test("observeOutboxMaxEntries is read from the config file and clamped at the cap", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-outbox-cap-"));
  try {
    const configPath = path.join(dir, "remnic.config.json");
    fs.writeFileSync(configPath, JSON.stringify({ authToken: "t", observeOutboxMaxEntries: 5000 }), "utf8");
    const config = loadConfig({ configPath, env: {} });
    assert.equal(config.observeOutboxMaxEntries, 5000, "the configured bound reaches the client");

    fs.writeFileSync(configPath, JSON.stringify({ authToken: "t", observeOutboxMaxEntries: 999_999 }), "utf8");
    assert.throws(
      () => loadConfig({ configPath, env: {} }),
      /observeOutboxMaxEntries/,
      "a bound past the cap is rejected loudly rather than silently honoured",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("observeOutboxMaxEntries defaults to a capacity that outlives a daemon restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-outbox-default-"));
  try {
    const configPath = path.join(dir, "remnic.config.json");
    fs.writeFileSync(configPath, JSON.stringify({ authToken: "t" }), "utf8");
    const config = loadConfig({ configPath, env: {} });
    assert.ok(
      (config.observeOutboxMaxEntries ?? 0) >= 1000,
      `default outbox capacity (${config.observeOutboxMaxEntries}) must hold a long daemon outage without evicting a lane's captures`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
