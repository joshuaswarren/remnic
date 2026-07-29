import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { cliMain, runServerHealthcheck } from "./index.js";

const CONFIG_TOKEN = "config-health-token";
const ENV_TOKEN = "env-health-token";
const ORDINARY_TOKEN = "remnic_gm_test-health-token";
const CHATGPT_TOKEN = "remnic_cg_test-health-token";
const HEALTH_ENV_KEYS = [
  "REMNIC_AUTH_TOKEN",
  "ENGRAM_AUTH_TOKEN",
  "REMNIC_PORT",
  "ENGRAM_PORT",
  "HOME",
] as const;

type HealthHarness = {
  port: number;
  requests: Array<{ authorization: string | undefined; url: string | undefined }>;
  close: () => Promise<void>;
};

async function listenForHealthRequest(options: {
  expectedToken: string;
  status?: number;
  hang?: boolean;
}): Promise<HealthHarness> {
  const requests: HealthHarness["requests"] = [];
  const server = createServer((incoming, response) => {
    requests.push({ authorization: incoming.headers.authorization, url: incoming.url });
    if (options.hang) return;
    const status = incoming.headers.authorization === `Bearer ${options.expectedToken}`
      ? (options.status ?? 200)
      : 401;
    response.writeHead(status).end();
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  return {
    port: address.port,
    requests,
    close: () => closeServer(server),
  };
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

async function writeConfig(
  fixtureDir: string,
  server: Record<string, unknown>,
): Promise<string> {
  const configPath = path.join(fixtureDir, "remnic.config.json");
  await writeFile(configPath, JSON.stringify({ server }));
  return configPath;
}

async function writeTokenStore(
  homeDir: string,
  tokens: Array<{ token: string; connector: string }>,
): Promise<void> {
  const storeDir = path.join(homeDir, ".remnic");
  await mkdir(storeDir, { recursive: true });
  await writeFile(
    path.join(storeDir, "tokens.json"),
    JSON.stringify({
      tokens: tokens.map((entry) => ({
        ...entry,
        createdAt: "2026-01-01T00:00:00.000Z",
      })),
    }),
  );
}

async function withHealthEnvironment(
  values: Partial<Record<(typeof HEALTH_ENV_KEYS)[number], string>>,
  callback: () => Promise<void>,
): Promise<void> {
  const original = Object.fromEntries(HEALTH_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of HEALTH_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    await callback();
  } finally {
    for (const key of HEALTH_ENV_KEYS) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("healthcheck authenticates with server.authToken from config", async () => {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "remnic-server-health-"));
  const harness = await listenForHealthRequest({ expectedToken: CONFIG_TOKEN });
  const configPath = await writeConfig(fixtureDir, { authToken: CONFIG_TOKEN, port: harness.port });

  try {
    await withHealthEnvironment({ HOME: fixtureDir }, async () => {
      await cliMain(["--healthcheck", "--config", configPath]);
    });
    assert.deepEqual(harness.requests, [{
      url: "/engram/v1/health",
      authorization: `Bearer ${CONFIG_TOKEN}`,
    }]);
  } finally {
    await harness.close();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("healthcheck applies env token and port over config", async () => {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "remnic-server-health-"));
  const harness = await listenForHealthRequest({ expectedToken: ENV_TOKEN });
  const configPath = await writeConfig(fixtureDir, { authToken: CONFIG_TOKEN, port: 1 });

  try {
    await withHealthEnvironment({
      HOME: fixtureDir,
      REMNIC_AUTH_TOKEN: ENV_TOKEN,
      REMNIC_PORT: String(harness.port),
    }, async () => {
      assert.equal(await runServerHealthcheck({ configPath }), true);
    });
    assert.equal(harness.requests[0]?.authorization, `Bearer ${ENV_TOKEN}`);
  } finally {
    await harness.close();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("healthcheck uses an eligible ordinary persisted connector token", async () => {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "remnic-server-health-"));
  const harness = await listenForHealthRequest({ expectedToken: ORDINARY_TOKEN });
  const configPath = await writeConfig(fixtureDir, {
    authToken: "${REMNIC_AUTH_TOKEN}",
    port: harness.port,
  });
  await writeTokenStore(fixtureDir, [{ token: ORDINARY_TOKEN, connector: "generic-mcp" }]);

  try {
    await withHealthEnvironment({ HOME: fixtureDir }, async () => {
      assert.equal(await runServerHealthcheck({ configPath }), true);
    });
    assert.equal(harness.requests[0]?.authorization, `Bearer ${ORDINARY_TOKEN}`);
  } finally {
    await harness.close();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("healthcheck rejects missing, placeholder, and ChatGPT-only tokens without a request", async () => {
  for (const fixture of [
    { authToken: undefined, tokens: [] },
    { authToken: "${REMNIC_AUTH_TOKEN}", tokens: [] },
    { authToken: "change-me", tokens: [] },
    { authToken: undefined, tokens: [{ token: CHATGPT_TOKEN, connector: "chatgpt" }] },
  ]) {
    const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "remnic-server-health-"));
    const harness = await listenForHealthRequest({ expectedToken: fixture.authToken ?? CHATGPT_TOKEN });
    const configPath = await writeConfig(fixtureDir, {
      port: harness.port,
      ...(fixture.authToken === undefined ? {} : { authToken: fixture.authToken }),
    });
    await writeTokenStore(fixtureDir, fixture.tokens);
    try {
      await withHealthEnvironment({ HOME: fixtureDir }, async () => {
        assert.equal(await runServerHealthcheck({ configPath }), false);
      });
      assert.deepEqual(harness.requests, []);
    } finally {
      await harness.close();
      await rm(fixtureDir, { recursive: true, force: true });
    }
  }
});

test("healthcheck does not reuse a revoked persisted token", async () => {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "remnic-server-health-"));
  const harness = await listenForHealthRequest({ expectedToken: ORDINARY_TOKEN });
  const configPath = await writeConfig(fixtureDir, { port: harness.port });
  await writeTokenStore(fixtureDir, [{ token: ORDINARY_TOKEN, connector: "generic-mcp" }]);
  await writeTokenStore(fixtureDir, []);

  try {
    await withHealthEnvironment({ HOME: fixtureDir }, async () => {
      assert.equal(await runServerHealthcheck({ configPath }), false);
    });
    assert.deepEqual(harness.requests, []);
  } finally {
    await harness.close();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("healthcheck accepts only HTTP 200", async () => {
  for (const status of [401, 503]) {
    const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "remnic-server-health-"));
    const harness = await listenForHealthRequest({ expectedToken: CONFIG_TOKEN, status });
    const configPath = await writeConfig(fixtureDir, { authToken: CONFIG_TOKEN, port: harness.port });
    try {
      await withHealthEnvironment({ HOME: fixtureDir }, async () => {
        assert.equal(await runServerHealthcheck({ configPath }), false);
      });
    } finally {
      await harness.close();
      await rm(fixtureDir, { recursive: true, force: true });
    }
  }
});

test("healthcheck fails boundedly on timeout and network error", async () => {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "remnic-server-health-"));
  const hangingHarness = await listenForHealthRequest({ expectedToken: CONFIG_TOKEN, hang: true });
  const timeoutConfig = await writeConfig(fixtureDir, {
    authToken: CONFIG_TOKEN,
    port: hangingHarness.port,
  });

  try {
    await withHealthEnvironment({ HOME: fixtureDir }, async () => {
      assert.equal(await runServerHealthcheck({ configPath: timeoutConfig, timeoutMs: 25 }), false);
    });
  } finally {
    await hangingHarness.close();
  }

  const closedServer = createServer();
  await listen(closedServer);
  const address = closedServer.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  const closedPort = address.port;
  await closeServer(closedServer);
  const networkConfig = await writeConfig(fixtureDir, {
    authToken: CONFIG_TOKEN,
    port: closedPort,
  });
  try {
    await withHealthEnvironment({ HOME: fixtureDir }, async () => {
      assert.equal(await runServerHealthcheck({ configPath: networkConfig, timeoutMs: 100 }), false);
    });
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});
test("cliMain healthcheck rejects --auth-token flag to avoid secret in argv", async () => {
  await assert.rejects(
    () => cliMain(["--healthcheck", "--auth-token", "synthetic-token"]),
    /Option --auth-token cannot be used with --healthcheck/,
  );
});

test("cliMain healthcheck throws on unhealthy server so process exits non-zero", async () => {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "remnic-server-health-"));
  const closedServer = createServer();
  await listen(closedServer);
  const address = closedServer.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  const closedPort = address.port;
  await closeServer(closedServer);

  const configPath = await writeConfig(fixtureDir, {
    authToken: CONFIG_TOKEN,
    port: closedPort,
  });

  try {
    await withHealthEnvironment({ HOME: fixtureDir }, async () => {
      await assert.rejects(
        () => cliMain(["--healthcheck", "--config", configPath]),
        /Server healthcheck failed/,
      );
    });
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});
test("cliMain healthcheck rejects --host option", async () => {
  await assert.rejects(
    () => cliMain(["--healthcheck", "--host", "127.0.0.1"]),
    /Option --host cannot be used with --healthcheck/,
  );
});
