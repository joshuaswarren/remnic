/**
 * Lifecycle matrix subject for the namespace catalog's repair after an incomplete read (#3297).
 * A catalog with a malformed row is read through the public `listNamespaces` API: the read
 * reports the incomplete catalog and schedules a rewrite that drops the bad row, so a fresh
 * instance over the persisted file and a repeated read both see a whole catalog.
 */
import assert from "node:assert/strict";
import { appendFile, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { NamespaceCatalog } from "../../namespaces/catalog.js";
import type { PluginConfig } from "../../types.js";
import { type LifecycleSubject, type MatrixRow, runLifecycleMatrix } from "../lifecycle-matrix.js";
import { mkTempMemoryDir } from "../orchestrator-lite.js";

const BAD_ROW = "{this is not json";

interface CatalogReadRepairState {
  dir: string;
  catalogPath: string;
  catalog: NamespaceCatalog;
  firstReasons: string[];
  firstNamespaces: string[];
  secondReasons?: string[];
  afterRepair?: string;
  afterSecondRead?: string;
}

/** Fixture config: the catalog reads only memoryDir, the namespace names and the enable flags. */
function catalogConfig(memoryDir: string): PluginConfig {
  return Object.assign(Object.create(null), {
    memoryDir,
    namespacesEnabled: true,
    namespaceCatalogEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
  });
}

/** Wait until the scheduled rewrite has removed the bad row (the read does not await it). */
async function waitForRepair(catalogPath: string): Promise<string> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const text = await readFile(catalogPath, "utf8");
    if (!text.includes(BAD_ROW) || Date.now() >= deadline) {
      // Let the rewrite finish its rename and release the catalog lock before anyone reads again.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return readFile(catalogPath, "utf8");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const subject: LifecycleSubject<CatalogReadRepairState> = {
  appliesTo(row: MatrixRow): boolean | string {
    if (row.id === "restart-reload-recovery") return true;
    if (row.id === "dedupe-replay") return true;
    return "catalog repair applies to persisted-state reload and repeated reads only";
  },

  async setup(row: MatrixRow): Promise<CatalogReadRepairState> {
    const dir = await mkTempMemoryDir(`catalog-read-repair-${row.id}`);
    try {
      const catalog = new NamespaceCatalog(catalogConfig(dir));
      await catalog.markWrite("project-origin-abc123", { discoveredBy: "write" });
      const catalogPath = path.join(dir, "state", "namespaces.jsonl");
      await appendFile(catalogPath, `${BAD_ROW}\n`, "utf8");
      return { dir, catalogPath, catalog, firstReasons: [], firstNamespaces: [] };
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  },

  async exercise(state: CatalogReadRepairState, row: MatrixRow): Promise<void> {
    const first = await state.catalog.listNamespaces(undefined, {
      onIncomplete: (reason) => state.firstReasons.push(reason),
    });
    state.firstNamespaces = first.map((record) => record.namespace);
    state.afterRepair = await waitForRepair(state.catalogPath);

    if (row.dimensions.restart) {
      // A fresh instance over the persisted (repaired) file.
      const restarted = new NamespaceCatalog(catalogConfig(state.dir));
      state.secondReasons = [];
      const reasons = state.secondReasons;
      await restarted.listNamespaces(undefined, { onIncomplete: (reason) => reasons.push(reason) });
    }

    if (row.dimensions.dedupeOrReplay) {
      // The same instance reads again: nothing to report and no second rewrite.
      state.secondReasons = [];
      const reasons = state.secondReasons;
      await state.catalog.listNamespaces(undefined, { onIncomplete: (reason) => reasons.push(reason) });
      await new Promise((resolve) => setTimeout(resolve, 100));
      state.afterSecondRead = await readFile(state.catalogPath, "utf8");
    }
  },

  async invariants(state: CatalogReadRepairState, row: MatrixRow): Promise<void> {
    assert.equal(state.firstReasons.length, 1, `${row.id}: the first read reports the malformed row`);
    assert.deepEqual(
      state.firstNamespaces,
      ["project-origin-abc123"],
      `${row.id}: the readable record is still returned`,
    );
    assert.ok(
      !(state.afterRepair ?? "").includes(BAD_ROW),
      `${row.id}: the scheduled rewrite dropped the malformed row`,
    );
    assert.match(state.afterRepair ?? "", /project-origin-abc123/, `${row.id}: the readable row survived the rewrite`);
    assert.deepEqual(state.secondReasons, [], `${row.id}: after the repair the catalog reads whole`);
    if (row.dimensions.dedupeOrReplay) {
      assert.equal(state.afterSecondRead, state.afterRepair, `${row.id}: a clean read does not rewrite again`);
    }
  },

  async teardown(state: CatalogReadRepairState): Promise<void> {
    await rm(state.dir, { recursive: true, force: true });
  },
};

runLifecycleMatrix("catalog-read-repair", subject);
