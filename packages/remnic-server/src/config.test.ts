import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfigFile, mergeRemnicConfigForServer, parseServerConfig } from "./index.js";

async function writeConfig(content: string): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-server-config-"));
  const filePath = path.join(dir, "config.json");
  await writeFile(filePath, content, "utf-8");
  return { filePath, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("server config merge preserves openaiApiKey=false over OPENAI_API_KEY env override", () => {
  const merged = mergeRemnicConfigForServer(
    {
      openaiApiKey: false,
      localLlmEnabled: true,
    },
    {
      openaiApiKey: "sk-env-should-not-be-used",
      memoryDir: "/tmp/remnic-memory",
    },
  );

  assert.equal(merged.openaiApiKey, false);
  assert.equal(merged.localLlmEnabled, true);
  assert.equal(merged.memoryDir, "/tmp/remnic-memory");
});

test("server config merge preserves string openaiApiKey=false over OPENAI_API_KEY env override", () => {
  const merged = mergeRemnicConfigForServer(
    {
      openaiApiKey: "false",
      localLlmEnabled: "true",
    },
    {
      openaiApiKey: "sk-env-should-not-be-used",
      memoryDir: "/tmp/remnic-memory",
    },
  );

  assert.equal(merged.openaiApiKey, "false");
  assert.equal(merged.localLlmEnabled, "true");
  assert.equal(merged.memoryDir, "/tmp/remnic-memory");
});

test("server config merge keeps env OPENAI_API_KEY when direct client is not disabled", () => {
  const merged = mergeRemnicConfigForServer(
    {
      localLlmEnabled: true,
    },
    {
      openaiApiKey: "sk-env",
    },
  );

  assert.equal(merged.openaiApiKey, "sk-env");
});

test("server config merge does not treat openaiApiKey=0 string as a direct client opt-out", () => {
  const merged = mergeRemnicConfigForServer(
    {
      openaiApiKey: "0",
      localLlmEnabled: "true",
    },
    {
      openaiApiKey: "sk-env",
      memoryDir: "/tmp/remnic-memory",
    },
  );

  assert.equal(merged.openaiApiKey, "sk-env");
  assert.equal(merged.localLlmEnabled, "true");
  assert.equal(merged.memoryDir, "/tmp/remnic-memory");
});

test("server config loader rejects non-object top-level JSON", async () => {
  for (const content of ["[]", "null", "\"bad\""]) {
    const { filePath, cleanup } = await writeConfig(content);
    try {
      assert.throws(
        () => loadConfigFile(filePath),
        /top-level config must be a JSON object/,
      );
    } finally {
      await cleanup();
    }
  }
});

test("server config loader rejects non-object remnic, engram, and server blocks", async () => {
  for (const content of [
    JSON.stringify({ remnic: [] }),
    JSON.stringify({ engram: "bad" }),
    JSON.stringify({ server: "bad" }),
  ]) {
    const { filePath, cleanup } = await writeConfig(content);
    try {
      assert.throws(
        () => loadConfigFile(filePath),
        /must be a JSON object/,
      );
    } finally {
      await cleanup();
    }
  }
});

test("server config parser validates and coerces supported fields", () => {
  const parsed = parseServerConfig({
    host: "127.0.0.1",
    port: "4321",
    authToken: "token",
    principal: "operator",
    maxBodyBytes: "2048" as unknown as number,
    adminConsoleEnabled: "false" as unknown as boolean,
    adminConsolePublicDir: "~/remnic-console",
  });

  assert.equal(parsed.host, "127.0.0.1");
  assert.equal(parsed.port, 4321);
  assert.equal(parsed.authToken, "token");
  assert.equal(parsed.principal, "operator");
  assert.equal(parsed.maxBodyBytes, 2048);
  assert.equal(parsed.adminConsoleEnabled, false);
  assert.equal(parsed.adminConsolePublicDir, "~/remnic-console");
});

test("server config parser rejects invalid field types", () => {
  assert.throws(
    () => parseServerConfig({ host: 123 as unknown as string }),
    /server\.host: expected a string/,
  );
  assert.throws(
    () => parseServerConfig({ host: "" }),
    /server\.host: expected a non-empty string/,
  );
  assert.throws(
    () => parseServerConfig({ authToken: 123 as unknown as string }),
    /server\.authToken: expected a string/,
  );
  assert.throws(
    () => parseServerConfig({ principal: 123 as unknown as string }),
    /server\.principal: expected a string/,
  );
  assert.throws(
    () => parseServerConfig({ maxBodyBytes: 1.5 }),
    /server\.maxBodyBytes: expected a positive integer/,
  );
  assert.throws(
    () => parseServerConfig({ adminConsoleEnabled: "sometimes" as unknown as boolean }),
    /server\.adminConsoleEnabled: expected a boolean/,
  );
  assert.throws(
    () => parseServerConfig({ adminConsolePublicDir: 123 as unknown as string }),
    /server\.adminConsolePublicDir: expected a string/,
  );
});
