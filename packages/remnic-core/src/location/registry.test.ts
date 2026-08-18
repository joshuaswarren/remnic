import assert from "node:assert/strict";
import test from "node:test";

import {
  clearLocationProviders,
  getLocationProvider,
  listLocationProviders,
  registerLocationProvider,
} from "./registry.js";
import type { LocationProvider } from "./types.js";

function provider(overrides: Partial<LocationProvider> = {}): LocationProvider {
  return {
    id: "fixture-provider",
    displayName: "Fixture Provider",
    async verify() {
      return { ok: true };
    },
    async fetchObservations() {
      return { observations: [], nextCursor: null };
    },
    ...overrides,
  };
}

test("registerLocationProvider registers, looks up, and lists sorted", () => {
  clearLocationProviders();
  registerLocationProvider(provider({ id: "zeta", displayName: "Z" }));
  registerLocationProvider(provider({ id: "alpha", displayName: "A" }));
  assert.deepEqual(listLocationProviders(), ["alpha", "zeta"]);
  assert.equal(getLocationProvider("alpha")?.displayName, "A");
  assert.equal(getLocationProvider("missing"), undefined);
});

test("registerLocationProvider rejects duplicate ids", () => {
  clearLocationProviders();
  registerLocationProvider(provider());
  assert.throws(() => registerLocationProvider(provider()), /already registered/);
});

test("registerLocationProvider rejects invalid ids", () => {
  clearLocationProviders();
  assert.throws(() => registerLocationProvider(provider({ id: "" })), RangeError);
  assert.throws(() => registerLocationProvider(provider({ id: "Upper" })), RangeError);
  assert.throws(() => registerLocationProvider(provider({ id: "has space" })), RangeError);
  assert.throws(() => registerLocationProvider(provider({ id: "../traversal" })), RangeError);
  assert.throws(
    () => registerLocationProvider(provider({ id: "x", displayName: "" as unknown as string })),
    TypeError,
  );
  assert.throws(
    () =>
      registerLocationProvider(
        provider({ id: "x", verify: undefined as unknown as LocationProvider["verify"] }),
      ),
    TypeError,
  );
  assert.throws(
    () =>
      registerLocationProvider(
        provider({ id: "x", fetchObservations: undefined as unknown as LocationProvider["fetchObservations"] }),
      ),
    TypeError,
  );
  assert.deepEqual(listLocationProviders(), []);
});

test("clearLocationProviders resets the registry", () => {
  clearLocationProviders();
  registerLocationProvider(provider());
  clearLocationProviders();
  assert.deepEqual(listLocationProviders(), []);
  assert.equal(getLocationProvider("fixture-provider"), undefined);
});
