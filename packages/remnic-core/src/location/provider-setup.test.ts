/**
 * Provider setup regression (issue #2047): env-credential bootstrapping of
 * optional provider packages — absent credentials or package are skips
 * (never errors), tokens never reach logs, and registration is idempotent.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseLocationConfig } from "./config.js";
import { clearLocationProviders, getLocationProvider, registerLocationProvider } from "./registry.js";
import {
  ensureConfiguredLocationProviders,
  getLocationProviderSetup,
  listLocationProviderSetups,
  registerLocationProviderSetup,
  resetLocationProviderSetups,
  unregisterLocationProviderSetup,
  type LocationProviderEnv,
  type LocationProviderSetupEntry,
} from "./provider-setup.js";
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

test.afterEach(() => {
  clearLocationProviders();
  resetLocationProviderSetups();
});

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

interface OwntracksModule {
  ensureOwntracksRegistered(opts: { baseUrl: string; token: string; timezone: string }): boolean;
}

function stubLocationProvider(id: string, displayName: string): LocationProvider {
  return {
    id,
    displayName,
    verify: async () => ({ ok: true }),
    fetchObservations: async () => ({ observations: [], nextCursor: null }),
  };
}

function makeOwntracksSetupEntry(calls: Array<{ baseUrl: string; token: string; timezone: string }>): LocationProviderSetupEntry {
  return {
    id: "owntracks",
    packageSpecifier: "@remnic/connector-owntracks",
    setup: async (context) => {
      const baseUrl = context.env?.baseUrl?.trim();
      const token = context.env?.token?.trim();
      if (!baseUrl || !token) return false;
      const mod = await context.loadPackage<OwntracksModule>();
      const opts = { baseUrl, token, timezone: context.config.timezone };
      calls.push(opts);
      return mod.ensureOwntracksRegistered(opts);
    },
  };
}

test("registers non-reitti provider registered in setup table with idempotency", async () => {
  const setupCalls: Array<{ baseUrl: string; token: string; timezone: string }> = [];
  const requestedSpecifiers: string[] = [];
  registerLocationProviderSetup(makeOwntracksSetupEntry(setupCalls));

  assert.equal(getLocationProviderSetup("owntracks")?.packageSpecifier, "@remnic/connector-owntracks");
  assert.ok(listLocationProviderSetups().includes("owntracks"));

  const importModule = async (specifier: string) => {
    requestedSpecifiers.push(specifier);
    const mod: OwntracksModule = {
      ensureOwntracksRegistered: () => {
        registerLocationProvider(stubLocationProvider("owntracks", "OwnTracks"));
        return true;
      },
    };
    return mod;
  };

  const config = parseLocationConfig({
    enabled: true,
    timezone: "America/Chicago",
    sources: [{ id: "owntracks" }],
  });
  const registered = await ensureConfiguredLocationProviders(config, {
    env: { baseUrl: "https://owntracks.example.invalid", token: "ot-secret" },
    importModule,
  });

  assert.deepEqual(registered, ["owntracks"]);
  assert.deepEqual(requestedSpecifiers, ["@remnic/connector-owntracks"]);
  assert.deepEqual(setupCalls, [
    { baseUrl: "https://owntracks.example.invalid", token: "ot-secret", timezone: "America/Chicago" },
  ]);
  assert.equal(getLocationProvider("owntracks")?.displayName, "OwnTracks");

  const registeredAgain = await ensureConfiguredLocationProviders(config, {
    env: { baseUrl: "https://owntracks.example.invalid", token: "ot-secret" },
    importModule,
  });
  assert.deepEqual(registeredAgain, []);
  assert.equal(requestedSpecifiers.length, 1);
});

test("bootstraps multiple configured sources independently using envBySource", async () => {
  const owntracksCalls: Array<{ baseUrl: string; token: string; timezone: string }> = [];
  registerLocationProviderSetup(makeOwntracksSetupEntry(owntracksCalls));

  const reittiLoader = importModuleDouble({ registered: true });
  const requestedSpecifiers: string[] = [];
  const importModule = async (specifier: string) => {
    requestedSpecifiers.push(specifier);
    if (specifier === "@remnic/connector-owntracks") {
      const mod: OwntracksModule = {
        ensureOwntracksRegistered: () => {
          registerLocationProvider(stubLocationProvider("owntracks", "OwnTracks"));
          return true;
        },
      };
      return mod;
    }
    return reittiLoader.importModule();
  };

  const config = parseLocationConfig({
    enabled: true,
    timezone: "UTC",
    sources: [{ id: "reitti" }, { id: "owntracks" }],
  });
  const envBySource = new Map<string, LocationProviderEnv>([
    ["reitti", ENV],
    ["owntracks", { baseUrl: "https://owntracks.example.invalid", token: "ot-token" }],
  ]);

  const registered = await ensureConfiguredLocationProviders(config, { envBySource, importModule });
  assert.deepEqual(registered, ["reitti", "owntracks"]);
  assert.deepEqual(requestedSpecifiers, ["@remnic/connector-reitti", "@remnic/connector-owntracks"]);
  assert.ok(getLocationProvider("reitti"));
  assert.ok(getLocationProvider("owntracks"));

  clearLocationProviders();
  const partialEnvBySource = new Map<string, LocationProviderEnv>([
    ["reitti", { baseUrl: ENV.baseUrl }],
    ["owntracks", { baseUrl: "https://owntracks.example.invalid", token: "ot-token" }],
  ]);
  const partialRegistered = await ensureConfiguredLocationProviders(config, {
    envBySource: partialEnvBySource,
    importModule,
  });
  assert.deepEqual(partialRegistered, ["owntracks"]);
});

test("setup registry validates ids, rejects duplicates, unregisters, and resets to defaults", async () => {
  assert.equal(getLocationProviderSetup("reitti")?.packageSpecifier, "@remnic/connector-reitti");
  assert.deepEqual(listLocationProviderSetups(), ["reitti"]);

  const dummySetup: LocationProviderSetupEntry["setup"] = async () => false;
  assert.throws(
    () => registerLocationProviderSetup({ id: "", packageSpecifier: "@remnic/x", setup: dummySetup }),
    RangeError,
  );
  assert.throws(
    () => registerLocationProviderSetup({ id: "UpperCase", packageSpecifier: "@remnic/x", setup: dummySetup }),
    RangeError,
  );
  assert.throws(
    () => registerLocationProviderSetup({ id: "../traversal", packageSpecifier: "@remnic/x", setup: dummySetup }),
    RangeError,
  );
  assert.throws(
    () => registerLocationProviderSetup({ id: "valid-id", packageSpecifier: "   ", setup: dummySetup }),
    TypeError,
  );
  assert.throws(
    () => registerLocationProviderSetup({ id: "reitti", packageSpecifier: "@remnic/other", setup: dummySetup }),
    /already registered/,
  );

  registerLocationProviderSetup({
    id: "custom-gps",
    packageSpecifier: "@remnic/connector-custom-gps",
    setup: async (context) => {
      await context.loadPackage<OwntracksModule>();
      registerLocationProvider(stubLocationProvider("custom-gps", "Custom GPS"));
      return true;
    },
  });
  assert.deepEqual(listLocationProviderSetups(), ["custom-gps", "reitti"]);
  assert.equal(unregisterLocationProviderSetup("custom-gps"), true);
  assert.equal(unregisterLocationProviderSetup("custom-gps"), false);

  let loaded = false;
  const skipped = await ensureConfiguredLocationProviders(
    parseLocationConfig({ enabled: true, sources: [{ id: "custom-gps" }] }),
    {
      env: ENV,
      importModule: async () => {
        loaded = true;
        return {};
      },
    },
  );
  assert.deepEqual(skipped, []);
  assert.equal(loaded, false);

  registerLocationProviderSetup({
    id: "custom-gps",
    packageSpecifier: "@remnic/connector-custom-gps",
    setup: dummySetup,
  });
  resetLocationProviderSetups();
  assert.deepEqual(listLocationProviderSetups(), ["reitti"]);
});

test("absent optional package and load failures on registered custom setup do not throw", async () => {
  const setupCalls: Array<{ baseUrl: string; token: string; timezone: string }> = [];
  registerLocationProviderSetup(makeOwntracksSetupEntry(setupCalls));
  registerLocationProviderSetup({
    id: "second-provider",
    packageSpecifier: "@remnic/connector-second",
    setup: async (context) => {
      const mod = await context.loadPackage<OwntracksModule>();
      return mod.ensureOwntracksRegistered({
        baseUrl: context.env?.baseUrl ?? "",
        token: context.env?.token ?? "",
        timezone: context.config.timezone,
      });
    },
  });

  const configOne = parseLocationConfig({ enabled: true, sources: [{ id: "owntracks" }] });
  const absent = await ensureConfiguredLocationProviders(configOne, {
    env: ENV,
    importModule: async () => {
      throw Object.assign(new Error("Cannot find module '@remnic/connector-owntracks'"), {
        code: "ERR_MODULE_NOT_FOUND",
      });
    },
  });
  assert.deepEqual(absent, []);

  const configBoth = parseLocationConfig({
    enabled: true,
    sources: [{ id: "owntracks" }, { id: "second-provider" }],
  });
  const partialAfterFailure = await ensureConfiguredLocationProviders(configBoth, {
    env: ENV,
    importModule: async (specifier: string) => {
      if (specifier === "@remnic/connector-owntracks") {
        throw new Error("syntax error in broken optional package");
      }
      const mod: OwntracksModule = {
        ensureOwntracksRegistered: () => {
          registerLocationProvider(stubLocationProvider("second-provider", "Second"));
          return true;
        },
      };
      return mod;
    },
  });
  assert.deepEqual(partialAfterFailure, ["second-provider"]);
});

test("getSetup dependency overrides global setup lookup", async () => {
  let calledSpecifier = "";
  const injectedEntry: LocationProviderSetupEntry = {
    id: "custom-seam",
    packageSpecifier: "@remnic/connector-seam",
    setup: async (context) => {
      await context.loadPackage<OwntracksModule>();
      registerLocationProvider(stubLocationProvider("custom-seam", "Custom Seam"));
      return true;
    },
  };

  const registered = await ensureConfiguredLocationProviders(
    parseLocationConfig({ enabled: true, sources: [{ id: "custom-seam" }] }),
    {
      importModule: async (specifier: string) => {
        calledSpecifier = specifier;
        return {};
      },
      getSetup: (id: string) => (id === "custom-seam" ? injectedEntry : undefined),
    },
  );
  assert.deepEqual(registered, ["custom-seam"]);
  assert.equal(calledSpecifier, "@remnic/connector-seam");
  assert.equal(getLocationProviderSetup("custom-seam"), undefined);
});
