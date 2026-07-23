import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

// Per-plugin runtime state is keyed by serviceId (#403 P2) so two plugin ids
// loaded in the same process don't trample each other.  This test registers
// the canonical plugin id (`openclaw-remnic`), so the keyed slots get that
// suffix; the migration promise stays unkeyed because legacy-dir migration is
// a one-time process-wide operation; the unkeyed orchestrator mirror is
// maintained by register() for cross-plugin observers.
const SERVICE_ID = "openclaw-remnic";
const GLOBAL_KEYS = [
  `__openclawEngramRegistered::${SERVICE_ID}`,
  `__openclawEngramHookApis::${SERVICE_ID}`,
  `__openclawEngramOrchestrator::${SERVICE_ID}`,
  `__openclawEngramAccessService::${SERVICE_ID}`,
  `__openclawEngramAccessHttpServer::${SERVICE_ID}`,
  `__openclawEngramServiceStarted::${SERVICE_ID}`,
  `__openclawEngramInitPromise::${SERVICE_ID}`,
  "__openclawEngramOrchestrator",
  "__openclawEngramCliRegistered",
  "__openclawEngramCliActiveServiceCount",
  "__openclawEngramMigrationPromise",
];

function resetGlobals(): void {
  for (const key of GLOBAL_KEYS) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

function buildApi() {
  return {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    pluginConfig: {},
    config: {},
    registerTool() {},
    registerCli() {},
    registerService() {},
    on() {},
  };
}

test.beforeEach(() => resetGlobals());
test.afterEach(() => resetGlobals());

test("plugin register triggers the first-run Engram migration path", async () => {
  const previousHome = process.env.HOME;
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "remnic-register-migrate-"));

  try {
    process.env.HOME = homeDir;
    await mkdir(path.join(homeDir, ".engram"), { recursive: true });
    await writeFile(
      path.join(homeDir, ".engram", "tokens.json"),
      JSON.stringify({ tokens: [] }),
      "utf8",
    );

    const { default: plugin } = await import("../src/index.js");
    plugin.register(buildApi() as any);

    await (globalThis as typeof globalThis & Record<string, Promise<unknown>>).__openclawEngramMigrationPromise;

    assert.equal(
      existsSync(path.join(homeDir, ".remnic", ".migrated-from-engram")),
      true,
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
