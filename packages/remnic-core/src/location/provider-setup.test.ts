/**
 * Provider setup regression (issue #2047): env-credential bootstrapping of
 * optional provider packages — absent credentials or package are skips
 * (never errors), tokens never reach logs, and registration is idempotent.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseLocationConfig } from "./config.js";
import { clearLocationProviders, getLocationProvider, registerLocationProvider } from "./registry.js";
import { ensureConfiguredLocationProviders, type LocationProviderEnv } from "./provider-setup.js";
import type { LocationProvider } from "./types.js";

const ENV: LocationProviderEnv = {
  baseUrl: "https://reitti.example.invalid",
  token: "secret-token",
  authMode: "x-api-token",
};

function importModuleDouble(options: { registered: boolean; failWith?: Error }) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    importModule: async () => {
      if (options.failWith) throw options.failWith;
      return {
        ensureReittiProviderRegistered: (opts: Record<string, unknown>) => {
          calls.push(opts);
          if (options.registered) {
            registerLocationProvider({
              id: "reitti",
              displayName: "Reitti",
              verify: async () => ({ ok: true }),
              fetchObservations: async () => ({ observations: [], nextCursor: null }),
            } satisfies LocationProvider);
            return true;
          }
          return false;
        },
      };
    },
  };
}

test.afterEach(() => clearLocationProviders());

test("registers reitti from env credentials with timezone threaded through", async () => {
  const config = parseLocationConfig({ enabled: true, timezone: "Europe/Berlin", sources: [{ id: "reitti" }] });
  const loader = importModuleDouble({ registered: true });
  const registered = await ensureConfiguredLocationProviders(config, { env: ENV, importModule: loader.importModule });
  assert.deepEqual(registered, ["reitti"]);
  assert.ok(getLocationProvider("reitti"));
  assert.deepEqual(loader.calls, [
    { baseUrl: ENV.baseUrl, token: ENV.token, timezone: "Europe/Berlin", authMode: "x-api-token" },
  ]);

  // Idempotent: a second call sees the registry and never re-imports.
  const registeredAgain = await ensureConfiguredLocationProviders(config, { env: ENV, importModule: loader.importModule });
  assert.deepEqual(registeredAgain, []);
  assert.equal(loader.calls.length, 1);
});

test("missing credentials or disabled config stay unregistered — skip, not error", async () => {
  const loader = importModuleDouble({ registered: true });
  const disabled = parseLocationConfig({ enabled: false, sources: [{ id: "reitti" }] });
  assert.deepEqual(await ensureConfiguredLocationProviders(disabled, { env: ENV, importModule: loader.importModule }), []);
  assert.equal(loader.calls.length, 0, "disabled config never loads packages");

  const missingToken = await ensureConfiguredLocationProviders(
    parseLocationConfig({ enabled: true, sources: [{ id: "reitti" }] }),
    { env: { baseUrl: ENV.baseUrl }, importModule: loader.importModule },
  );
  assert.deepEqual(missingToken, []);
  assert.equal(loader.calls.length, 0, "missing token never loads packages");
  assert.equal(getLocationProvider("reitti"), undefined);
});

test("optional package absent (module-not-found naming the specifier) is silent", async () => {
  const config = parseLocationConfig({ enabled: true, sources: [{ id: "reitti" }] });
  const registered = await ensureConfiguredLocationProviders(config, {
    env: ENV,
    importModule: async () => {
      throw Object.assign(new Error("Cannot find module '@remnic/connector-reitti'"), { code: "ERR_MODULE_NOT_FOUND" });
    },
  });
  assert.deepEqual(registered, []);
  assert.equal(getLocationProvider("reitti"), undefined);
});

test("unknown provider ids and unknown sources are skipped without imports", async () => {
  const loader = importModuleDouble({ registered: true });
  const config = parseLocationConfig({ enabled: true, sources: [{ id: "future-provider" }, { id: "reitti", enabled: false }] });
  assert.deepEqual(await ensureConfiguredLocationProviders(config, { env: ENV, importModule: loader.importModule }), []);
  assert.equal(loader.calls.length, 0, "unknown + disabled sources never load packages");
});

test("invalid authMode falls back to the connector default (single header form)", async () => {
  const loader = importModuleDouble({ registered: true });
  const config = parseLocationConfig({ enabled: true, sources: [{ id: "reitti" }] });
  await ensureConfiguredLocationProviders(config, {
    env: { ...ENV, authMode: "both" },
    importModule: loader.importModule,
  });
  assert.equal("authMode" in (loader.calls[0] ?? {}), false, "invalid mode must not be forwarded");
});
