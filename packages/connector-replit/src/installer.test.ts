import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { generateReplitInstructions } from "./installer.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("generateReplitInstructions preserves the localhost shorthand", () => {
  const setup = generateReplitInstructions("token");

  assert.equal(setup.mcpConfig.url, "http://localhost:4318/mcp");
  assert.match(setup.instructions, /Enter URL: http:\/\/localhost:4318\/mcp/);
});

test("generateReplitInstructions accepts HTTPS origins for cloud Replit", () => {
  const setup = generateReplitInstructions("token", "https://remnic.example.com", 443);

  assert.equal(setup.mcpConfig.url, "https://remnic.example.com/mcp");
});

test("generateReplitInstructions accepts an explicit baseUrl option", () => {
  const setup = generateReplitInstructions("token", { baseUrl: "https://remnic.example.com:8443" });

  assert.equal(setup.mcpConfig.url, "https://remnic.example.com:8443/mcp");
});

test("generateReplitInstructions uses Remnic naming in generated prose", () => {
  const setup = generateReplitInstructions("token");
  const proseWithoutLegacyHeader = setup.instructions
    .split("\n")
    .filter((line) => !line.includes("X-Engram-Client-Id"))
    .join("\n");

  assert.match(proseWithoutLegacyHeader, /Remnic MCP endpoint/);
  assert.match(proseWithoutLegacyHeader, /Remnic MCP tools/);
  assert.doesNotMatch(proseWithoutLegacyHeader, /\bEMO\b/);
  assert.doesNotMatch(proseWithoutLegacyHeader, /\bengram\b/i);
});

test("package metadata documents externally supplied token setup", async () => {
  const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    description?: string;
  };
  const readme = await readFile(join(packageRoot, "README.md"), "utf8");

  assert.match(packageJson.description ?? "", /existing token/);
  assert.doesNotMatch(packageJson.description ?? "", /token generator/);
  assert.match(readme, /bearer token that you mint separately/);
  assert.match(readme, /remnic token generate replit/);
});

test("generateReplitInstructions rejects malformed host values", () => {
  assert.throws(
    () => generateReplitInstructions("token", "https://remnic.example.com/api"),
    /origin without a path/,
  );
  assert.throws(() => generateReplitInstructions("token", "localhost/mcp"), /must not include/);
  assert.throws(() => generateReplitInstructions("token", "localhost", 0), /integer between 1 and 65535/);
});
