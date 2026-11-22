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

test("register prefers the gateway-passed config over a disk read (#3612)", async (t) => {
  const previousHome = process.env.HOME;
  const previousConfigPath = process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "remnic-register-gateway-cfg-"));
  const configPath = path.join(homeDir, "openclaw.json");

  try {
    process.env.HOME = homeDir;
    // The disk file is MALFORMED on purpose: any fallback read warns
    // "Failed to load" — an observable tell that register touched the disk.
    await writeFile(configPath, "{ not json", "utf8");
    process.env.OPENCLAW_ENGRAM_CONFIG_PATH = configPath;

    const warnings: string[] = [];
    const infos: string[] = [];
    const api = {
      logger: {
        debug() {},
        info(m: string) { infos.push(String(m)); },
        warn(m: string) { warnings.push(String(m)); },
        error() {},
      },
      pluginConfig: {},
      // The gateway snapshot carries the operator-authored plugin entry —
      // same shape as the on-disk file (plugins.entries.<id>.config).
      config: {
        plugins: {
          entries: {
            "openclaw-remnic": {
              id: "openclaw-remnic",
              config: { debug: true },
              hooks: {},
            },
          },
        },
      },
      registerTool() {},
      registerCli() {},
      registerService() {},
      on() {},
    };

    const { default: plugin } = await import("../src/index.js");
    // SAFETY: buildApi() only stubs the register() surface this test
    // exercises; register() treats the api as the SDK's OpenClawPluginApi.
    plugin.register(api as any);

    const loadWarnings = warnings.filter((m) => m.includes("Failed to load"));
    assert.deepEqual(
      loadWarnings,
      [],
      "register must not read openclaw.json when the gateway passed the plugin entry",
    );
    assert.ok(
      infos.some((m) => m.includes("debug=true")),
      `gateway-passed config must drive the parsed config (debug=true); got: ${infos.join(" | ")}`,
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousConfigPath === undefined) delete process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
    else process.env.OPENCLAW_ENGRAM_CONFIG_PATH = previousConfigPath;
  }
});
