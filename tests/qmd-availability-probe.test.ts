import test from "node:test";
import assert from "node:assert/strict";
import { probeQmdAvailability } from "../src/qmd-availability-probe.ts";

test("returns true when isAvailable() reports true without calling probe", async () => {
  let probeCalls = 0;
  const result = await probeQmdAvailability({
    qmd: {
      isAvailable: () => true,
      probe: async () => {
        probeCalls += 1;
        return true;
      },
    },
  });
  assert.equal(result, true);
  assert.equal(probeCalls, 0);
});

test("falls back to probe() when isAvailable() reports false", async () => {
  let probeCalls = 0;
  const result = await probeQmdAvailability({
    qmd: {
      isAvailable: () => false,
      probe: async () => {
        probeCalls += 1;
        return true;
      },
    },
  });
  assert.equal(result, true);
  assert.equal(probeCalls, 1);
});

test("returns false when both isAvailable() and probe() report false", async () => {
  const result = await probeQmdAvailability({
    qmd: {
      isAvailable: () => false,
      probe: async () => false,
    },
  });
  assert.equal(result, false);
});

test("treats probe() rejection as unavailable rather than throwing", async () => {
  const result = await probeQmdAvailability({
    qmd: {
      isAvailable: () => false,
      probe: async () => {
        throw new Error("daemon offline");
      },
    },
  });
  assert.equal(result, false);
});

test("returns false when qmd is missing entirely", async () => {
  assert.equal(await probeQmdAvailability({}), false);
  assert.equal(await probeQmdAvailability({ qmd: undefined }), false);
});

test("returns false when isAvailable is missing and probe is missing", async () => {
  assert.equal(await probeQmdAvailability({ qmd: {} }), false);
});

test("uses probe() when isAvailable is missing", async () => {
  const result = await probeQmdAvailability({
    qmd: {
      probe: async () => true,
    },
  });
  assert.equal(result, true);
});
