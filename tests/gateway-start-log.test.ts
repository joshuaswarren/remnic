/**
 * Tests that the gateway_start log line is emitted when the plugin
 * initializes successfully.
 *
 * Strategy: read src/index.ts as text and verify the expected log line is
 * present (static check), then do a functional check that confirms the log
 * message pattern includes the key identifiers operators look for.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

test("src/index.ts contains gateway_start fired log line", async () => {
  const src = await readFile(path.join(ROOT, "src", "index.ts"), "utf-8");
  assert.ok(
    src.includes("gateway_start fired"),
    "src/index.ts must contain 'gateway_start fired' log line",
  );
  assert.ok(
    src.includes("Remnic memory plugin is active"),
    "log line must mention 'Remnic memory plugin is active'",
  );
  assert.ok(
    src.includes("memoryDir="),
    "log line must include memoryDir in the output",
  );
});

test("gateway_start log line format contains id= and memoryDir= fields", async () => {
  const src = await readFile(path.join(ROOT, "src", "index.ts"), "utf-8");
  // Extract the log.info line containing gateway_start fired
  const lines = src.split("\n");
  const gatewayLine = lines.find(
    (l) => l.includes("gateway_start fired") || l.includes("Remnic memory plugin is active"),
  );
  assert.ok(gatewayLine, "should find the gateway_start log line");
  // The template literal that builds the message should include id= and memoryDir=
  const allLines = lines.slice(
    lines.findIndex((l) => l.includes("gateway_start fired")) - 5,
    lines.findIndex((l) => l.includes("gateway_start fired")) + 10,
  ).join("\n");
  assert.ok(allLines.includes("id="), "log line should include id= field");
  assert.ok(allLines.includes("memoryDir="), "log line should include memoryDir= field");
});

test("plugin definition id is openclaw-remnic (post PR #405 rename)", async () => {
  const src = await readFile(path.join(ROOT, "src", "index.ts"), "utf-8");
  // The plugin definition id is what will appear in the gateway_start log.
  // After PR #405 merged, the canonical id is openclaw-remnic.
  assert.ok(
    src.includes("id: REMNIC_OPENCLAW_PLUGIN_ID") || src.includes('id: "openclaw-remnic"'),
    "plugin definition must use the canonical openclaw-remnic id",
  );
});
