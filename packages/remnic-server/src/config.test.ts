import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "@remnic/core";
import { createAdminControls, envOverrides, loadConfigFile, mergeRemnicConfigForServer, parseServerConfig } from "./index.js";

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

test("server config loader merges partial remnic and engram blocks over legacy flat core keys", async () => {
  for (const nestedKey of ["remnic", "engram"] as const) {
    const { filePath, cleanup } = await writeConfig(JSON.stringify({
      namespacesEnabled: true,
      defaultNamespace: "generalist",
      lcmEnabled: true,
      wearables: { enabled: true, timezone: "America/Chicago" },
      [nestedKey]: { wearables: { enabled: false } },
      server: { principal: "fleet" },
    }));
    try {
      const loaded = loadConfigFile(filePath);
      assert.deepEqual(loaded.remnic, {
        namespacesEnabled: true,
        defaultNamespace: "generalist",
        lcmEnabled: true,
        wearables: { enabled: false },
      });
      assert.deepEqual(loaded.server, { principal: "fleet" });
    } finally {
      await cleanup();
    }
  }
});

test("admin null reset removes nested values and their flat fallbacks", async () => {
  const { filePath, cleanup } = await writeConfig(JSON.stringify({
    namespacesEnabled: true,
    localLlmUrl: "http://127.0.0.1:1/v1",
    remnic: { namespacesEnabled: false },
    server: { adminConsoleEnabled: true },
  }));
  try {
    const loaded = loadConfigFile(filePath);
    const controls = createAdminControls(
      filePath,
      parseConfig(loaded.remnic),
      parseServerConfig(loaded.server),
    );

    const status = await controls.update?.({ namespacesEnabled: null });
    const written = JSON.parse(await readFile(filePath, "utf8"));

    assert.equal(Object.hasOwn(written, "namespacesEnabled"), false);
    assert.equal(Object.hasOwn(written.remnic, "namespacesEnabled"), false);
    assert.equal(status?.config.values.namespacesEnabled, false);
  } finally {
    await cleanup();
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
    adminConsolePrefillToken: "true" as unknown as boolean,
  });

  assert.equal(parsed.host, "127.0.0.1");
  assert.equal(parsed.port, 4321);
  assert.equal(parsed.authToken, "token");
  assert.equal(parsed.principal, "operator");
  assert.equal(parsed.maxBodyBytes, 2048);
  assert.equal(parsed.adminConsoleEnabled, false);
  assert.equal(parsed.adminConsolePublicDir, "~/remnic-console");
  assert.equal(parsed.adminConsolePrefillToken, true);
});

test("server config parser disables the admin console by default", () => {
  assert.equal(parseServerConfig({}).adminConsoleEnabled, false);
  assert.equal(parseServerConfig({ adminConsoleEnabled: true }).adminConsoleEnabled, true);
  assert.equal(parseServerConfig({ adminConsoleEnabled: false }).adminConsoleEnabled, false);
  assert.equal(parseServerConfig({}).adminConsolePrefillToken, false);
});

test("server config parser defaults trustPrincipalHeader to false and accepts boolean-like strings", () => {
  assert.equal(parseServerConfig({}).trustPrincipalHeader, false);
  assert.equal(parseServerConfig({ trustPrincipalHeader: true }).trustPrincipalHeader, true);
  assert.equal(
    parseServerConfig({ trustPrincipalHeader: "true" as unknown as boolean }).trustPrincipalHeader,
    true,
  );
  assert.equal(
    parseServerConfig({ trustPrincipalHeader: "0" as unknown as boolean }).trustPrincipalHeader,
    false,
  );
});

test("server config parser rejects invalid trustPrincipalHeader values", () => {
  assert.throws(
    () => parseServerConfig({ trustPrincipalHeader: "maybe" as unknown as boolean }),
    /server\.trustPrincipalHeader: expected a boolean/,
  );
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
  assert.throws(
    () => parseServerConfig({ adminConsolePrefillToken: "sometimes" as unknown as boolean }),
    /server\.adminConsolePrefillToken: expected a boolean/,
  );
});

test("parseServerConfig write rate limit keys: optional, string-coerced, invalid rejected (issue #1937)", () => {
  // Unset -> undefined (EngramAccessHttpServer applies the 30/60000 defaults).
  const defaults = parseServerConfig({});
  assert.equal(defaults.writeRateLimitMaxRequests, undefined);
  assert.equal(defaults.writeRateLimitWindowMs, undefined);

  const custom = parseServerConfig({
    writeRateLimitMaxRequests: 120,
    writeRateLimitWindowMs: 30000,
  });
  assert.equal(custom.writeRateLimitMaxRequests, 120);
  assert.equal(custom.writeRateLimitWindowMs, 30000);

  // CLI/env-sourced numerics arrive as strings — coerce, don't reject.
  const coerced = parseServerConfig({
    writeRateLimitMaxRequests: "120" as unknown as number,
    writeRateLimitWindowMs: "30000" as unknown as number,
  });
  assert.equal(coerced.writeRateLimitMaxRequests, 120);
  assert.equal(coerced.writeRateLimitWindowMs, 30000);

  for (const bad of [0, -5, 1.5, "abc"]) {
    assert.throws(
      () => parseServerConfig({ writeRateLimitMaxRequests: bad as unknown as number }),
      /server\.writeRateLimitMaxRequests: expected a positive integer/,
      `writeRateLimitMaxRequests=${JSON.stringify(bad)} must throw`,
    );
    assert.throws(
      () => parseServerConfig({ writeRateLimitWindowMs: bad as unknown as number }),
      /server\.writeRateLimitWindowMs: expected a positive integer/,
      `writeRateLimitWindowMs=${JSON.stringify(bad)} must throw`,
    );
  }
});

test("envOverrides write rate limit env: precedence, legacy fallback, invalid rejected (issue #2029)", () => {
  const keys = [
    "REMNIC_WRITE_RATE_LIMIT_MAX_REQUESTS",
    "REMNIC_WRITE_RATE_LIMIT_WINDOW_MS",
    "ENGRAM_WRITE_RATE_LIMIT_MAX_REQUESTS",
    "ENGRAM_WRITE_RATE_LIMIT_WINDOW_MS",
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const clear = () => {
    for (const k of keys) delete process.env[k];
  };
  try {
    // REMNIC_ wins over a conflicting ENGRAM_ value, for both fields.
    clear();
    process.env.REMNIC_WRITE_RATE_LIMIT_MAX_REQUESTS = "1800";
    process.env.ENGRAM_WRITE_RATE_LIMIT_MAX_REQUESTS = "99";
    process.env.REMNIC_WRITE_RATE_LIMIT_WINDOW_MS = "30000";
    process.env.ENGRAM_WRITE_RATE_LIMIT_WINDOW_MS = "1";
    let parsed = parseServerConfig(envOverrides());
    assert.equal(parsed.writeRateLimitMaxRequests, 1800);
    assert.equal(parsed.writeRateLimitWindowMs, 30000);

    // Legacy ENGRAM_ name is honored when the REMNIC_ name is unset — both fields.
    clear();
    process.env.ENGRAM_WRITE_RATE_LIMIT_MAX_REQUESTS = "42";
    process.env.ENGRAM_WRITE_RATE_LIMIT_WINDOW_MS = "45000";
    parsed = parseServerConfig(envOverrides());
    assert.equal(parsed.writeRateLimitMaxRequests, 42);
    assert.equal(parsed.writeRateLimitWindowMs, 45000);

    // Invalid env values reach validation and are rejected, not silently dropped.
    for (const bad of ["0", "", "abc", "1.5"]) {
      clear();
      process.env.REMNIC_WRITE_RATE_LIMIT_MAX_REQUESTS = bad;
      assert.throws(
        () => parseServerConfig(envOverrides()),
        /server\.writeRateLimitMaxRequests: expected a positive integer/,
        `max=${JSON.stringify(bad)} must be rejected`,
      );
    }
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test("envOverrides honors REMNIC_READY_DEGRADED_AFTER_ATTEMPTS with legacy fallback (issue #2215)", () => {
  const keys = ["REMNIC_READY_DEGRADED_AFTER_ATTEMPTS", "ENGRAM_READY_DEGRADED_AFTER_ATTEMPTS"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const clear = () => {
    for (const k of keys) delete process.env[k];
  };
  try {
    clear();
    assert.equal(parseServerConfig(envOverrides()).readinessDegradedAfterAttempts, 3);

    process.env.REMNIC_READY_DEGRADED_AFTER_ATTEMPTS = "0";
    assert.equal(parseServerConfig(envOverrides()).readinessDegradedAfterAttempts, 0);

    // REMNIC_ wins over a conflicting legacy ENGRAM_ value.
    process.env.REMNIC_READY_DEGRADED_AFTER_ATTEMPTS = "7";
    process.env.ENGRAM_READY_DEGRADED_AFTER_ATTEMPTS = "9";
    assert.equal(parseServerConfig(envOverrides()).readinessDegradedAfterAttempts, 7);

    // Legacy ENGRAM_ name is honored when the REMNIC_ name is unset.
    clear();
    process.env.ENGRAM_READY_DEGRADED_AFTER_ATTEMPTS = "0";
    assert.equal(parseServerConfig(envOverrides()).readinessDegradedAfterAttempts, 0);

    // Invalid env values reach validation and are rejected, not silently dropped.
    clear();
    process.env.REMNIC_READY_DEGRADED_AFTER_ATTEMPTS = "nope";
    assert.throws(
      () => parseServerConfig(envOverrides()),
      /server\.readinessDegradedAfterAttempts: expected a non-negative integer/,
    );
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test("server config parser disables the memory review deck by default (issue #2351)", () => {
  assert.equal(parseServerConfig({}).adminConsoleMemoryReviewEnabled, false);
  assert.equal(parseServerConfig({ adminConsoleMemoryReviewEnabled: true }).adminConsoleMemoryReviewEnabled, true);
  assert.equal(parseServerConfig({ adminConsoleMemoryReviewEnabled: false }).adminConsoleMemoryReviewEnabled, false);
  assert.equal(
    parseServerConfig({ adminConsoleMemoryReviewEnabled: "false" as unknown as boolean }).adminConsoleMemoryReviewEnabled,
    false,
  );
  assert.equal(
    parseServerConfig({ adminConsoleMemoryReviewEnabled: "0" as unknown as boolean }).adminConsoleMemoryReviewEnabled,
    false,
  );
  assert.equal(
    parseServerConfig({ adminConsoleMemoryReviewEnabled: "true" as unknown as boolean }).adminConsoleMemoryReviewEnabled,
    true,
  );
  assert.throws(
    () => parseServerConfig({ adminConsoleMemoryReviewEnabled: "sometimes" as unknown as boolean }),
    /server\.adminConsoleMemoryReviewEnabled: expected a boolean/,
  );
});

test("envOverrides honors REMNIC_ADMIN_CONSOLE_MEMORY_REVIEW_ENABLED with legacy fallback (issue #2351)", () => {
  const keys = [
    "REMNIC_ADMIN_CONSOLE_MEMORY_REVIEW_ENABLED",
    "ENGRAM_ADMIN_CONSOLE_MEMORY_REVIEW_ENABLED",
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const clear = () => {
    for (const k of keys) delete process.env[k];
  };
  try {
    clear();
    assert.equal(parseServerConfig(envOverrides()).adminConsoleMemoryReviewEnabled, false);

    process.env.REMNIC_ADMIN_CONSOLE_MEMORY_REVIEW_ENABLED = "true";
    process.env.ENGRAM_ADMIN_CONSOLE_MEMORY_REVIEW_ENABLED = "false";
    assert.equal(parseServerConfig(envOverrides()).adminConsoleMemoryReviewEnabled, true);

    clear();
    process.env.ENGRAM_ADMIN_CONSOLE_MEMORY_REVIEW_ENABLED = "true";
    assert.equal(parseServerConfig(envOverrides()).adminConsoleMemoryReviewEnabled, true);

    clear();
    process.env.REMNIC_ADMIN_CONSOLE_MEMORY_REVIEW_ENABLED = "false";
    assert.equal(parseServerConfig(envOverrides()).adminConsoleMemoryReviewEnabled, false);

    clear();
    process.env.REMNIC_ADMIN_CONSOLE_MEMORY_REVIEW_ENABLED = "sometimes";
    assert.throws(
      () => parseServerConfig(envOverrides()),
      /server\.adminConsoleMemoryReviewEnabled: expected a boolean/,
    );
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
