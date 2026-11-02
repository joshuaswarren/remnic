import assert from "node:assert/strict";
import test from "node:test";

import { refreshConvergedNamespaces } from "./convergence-refresh.js";

test("a min-interval QMD skip does not fail convergence refresh", async () => {
  let continued = false;
  await assert.rejects(
    () => refreshConvergedNamespaces(
      ["generalist"],
      {
        updateNamespacesDetailed: async () => {
          throw new Error("QMD update skipped by global min-interval gate");
        },
      },
      async () => {
        continued = true;
        throw new Error("storage-reached");
      },
      false,
    ),
    /storage-reached/,
  );
  assert.equal(continued, true);
});

test("a real QMD refresh failure still fails convergence refresh", async () => {
  let continued = false;
  await assert.rejects(
    () => refreshConvergedNamespaces(
      ["generalist"],
      {
        updateNamespacesDetailed: async () => {
          throw new Error("qmd exploded");
        },
      },
      async () => {
        continued = true;
        throw new Error("storage-reached");
      },
      false,
    ),
    /qmd exploded/,
  );
  assert.equal(continued, false);
});
