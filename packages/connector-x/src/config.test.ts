import assert from "node:assert/strict";
import { test } from "node:test";

import {
  XConfigError,
  coerceXBool,
  monthlyCostCapUsd,
  parseXConnectorConfig,
  resolveMcpClientCredentials,
} from "./config.js";

test("parses a full block and applies defaults", () => {
  const config = parseXConnectorConfig({
    userId: "123456",
    sources: [
      {
        id: "x-mcp",
        kind: "mcp",
        auth: { tokenFile: "~/secrets/x-tokens.json" },
        budget: { maxPagesPerSync: 3, maxCostUsdPerMonth: 2.0 },
      },
      { id: "local", kind: "corpusDir", path: "~/corpus" },
    ],
    sourcePriority: ["local", "x-mcp"],
  });
  assert.equal(config.enabled, true);
  assert.equal(config.memoryMode, "suggest");
  assert.equal(config.syncSchedule, "3x-daily");
  assert.equal(config.sources.length, 2);
  const mcp = config.sources[0];
  assert.ok(mcp.kind === "mcp");
  assert.equal(mcp.url, "https://api.x.com/mcp");
  assert.equal(mcp.bookmarksTool, "get_users_bookmarks");
  assert.equal(mcp.budget.maxPagesPerSync, 3);
  assert.equal(mcp.budget.costPerReadUsd, 0.01);
  assert.equal(config.stateDir, "~/.remnic/x-connector");
});

test("coerces boolean-like strings and rejects garbage", () => {
  assert.equal(coerceXBool("false", "f"), false);
  assert.equal(coerceXBool("0", "f"), false);
  assert.equal(coerceXBool("yes", "f"), true);
  assert.throws(() => coerceXBool("maybe", "f"), XConfigError);
});

test("enabled=false string survives the boundary", () => {
  const config = parseXConnectorConfig({ enabled: "false", sources: [{ id: "a", kind: "corpusDir", path: "/tmp/x" }] });
  assert.equal(config.enabled, false);
});

test("rejects unknown source kinds", () => {
  assert.throws(() => parseXConnectorConfig({ sources: [{ id: "s", kind: "scrape" }] }), /kind must be one of/);
});

test("rejects duplicate source ids", () => {
  assert.throws(
    () =>
      parseXConnectorConfig({
        sources: [
          { id: "dup", kind: "corpusDir", path: "/tmp/a" },
          { id: "dup", kind: "cli" },
        ],
      }),
    /duplicate source id/
  );
});

test("rejects priorities naming unknown sources", () => {
  assert.throws(
    () =>
      parseXConnectorConfig({
        sources: [{ id: "a", kind: "corpusDir", path: "/tmp/a" }],
        sourcePriority: ["ghost"],
      }),
    /unknown source id/
  );
});

test("rejects non-numeric userId and bad enum values", () => {
  assert.throws(() => parseXConnectorConfig({ userId: "jane", sources: [] }), /numeric/);
  assert.throws(
    () =>
      parseXConnectorConfig({
        memoryMode: "auto",
        sources: [{ id: "a", kind: "corpusDir", path: "/tmp/a" }],
      }),
    /memoryMode/
  );
  assert.throws(
    () =>
      parseXConnectorConfig({
        syncSchedule: "5x-daily",
        sources: [{ id: "a", kind: "corpusDir", path: "/tmp/a" }],
      }),
    /syncSchedule/
  );
});

test("rejects invalid budget numbers instead of clamping", () => {
  assert.throws(
    () =>
      parseXConnectorConfig({
        sources: [{ id: "m", kind: "mcp", budget: { maxPagesPerSync: 0 } }],
      }),
    /maxPagesPerSync/
  );
  assert.throws(
    () =>
      parseXConnectorConfig({
        sources: [{ id: "m", kind: "mcp", budget: { maxCostUsdPerMonth: -1 } }],
      }),
    /maxCostUsdPerMonth/
  );
  assert.throws(
    () =>
      parseXConnectorConfig({
        sources: [{ id: "m", kind: "mcp", budget: { maxPagesPerSync: 2.5 } }],
      }),
    /maxPagesPerSync/
  );
});

test("rejects an empty sources array", () => {
  assert.throws(() => parseXConnectorConfig({ sources: [] }), /non-empty array/);
});

test("monthlyCostCapUsd is the max across mcp sources only", () => {
  const config = parseXConnectorConfig({
    sources: [
      { id: "m1", kind: "mcp", budget: { maxCostUsdPerMonth: 0.5 } },
      { id: "m2", kind: "mcp", budget: { maxCostUsdPerMonth: 1.5 } },
      { id: "c", kind: "corpusDir", path: "/tmp/c" },
    ],
  });
  assert.equal(monthlyCostCapUsd(config), 1.5);
});

test("resolveMcpClientCredentials prefers REMNIC_* env names", () => {
  const mcp = parseXConnectorConfig({
    sources: [{ id: "m", kind: "mcp" }],
  }).sources[0];
  assert.ok(mcp.kind === "mcp");
  const creds = resolveMcpClientCredentials(mcp, {
    REMNIC_X_CLIENT_ID: "primary",
    X_CLIENT_ID: "secondary",
    REMNIC_X_CLIENT_SECRET: "secret",
  });
  assert.equal(creds.clientId, "primary");
  assert.equal(creds.clientSecret, "secret");
  assert.equal(creds.tokenFile, "~/.openclaw/secrets/x-tokens.json");
});
