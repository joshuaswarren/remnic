import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  DIRECTORY_SIDECAR_BASENAME,
  DIRECTORY_SIDECAR_MARKER,
  findDirectorySidecarsForQuery,
  loadDirectorySidecar,
  runDirectorySidecarMaintenance,
} from "./directory-sidecars.js";
import {
  isGenericRecallExcludedPath,
  isSearchExcludedPath,
} from "./orchestration/generic-recall-paths.js";

function store(): string {
  return mkdtempSync(path.join(os.tmpdir(), "dir-sidecars-"));
}

async function writeMemory(root: string, rel: string, body: string): Promise<string> {
  const target = path.join(root, rel);
  await mkdir(path.dirname(target), { recursive: true });
  writeFileSync(target, `---\ncategory: fact\n---\n${body}\n`);
  return target;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

test("maintenance writes sidecars bottom-up and skips unchanged on rerun", async () => {
  const root = store();
  try {
    await writeMemory(root, "facts/2026-01-02/fact-1.md", "Telescope calibration log for the north dome.");
    await writeMemory(root, "facts/2026-01-03/fact-2.md", "Guide star acquisition failed twice.");
    await writeMemory(root, "entities/obs-1.md", "The north dome observer rotation schedule.");

    const first = await runDirectorySidecarMaintenance(root, true);
    const dayDir = path.join(root, "facts", "2026-01-02");
    const monthParent = path.join(root, "facts");
    assert.ok(
      first.written.some((p) => p === path.join(dayDir, DIRECTORY_SIDECAR_BASENAME)),
      "day sidecar written",
    );
    assert.ok(
      first.written.some((p) => p === path.join(monthParent, DIRECTORY_SIDECAR_BASENAME)),
      "parent sidecar written after children (bottom-up)",
    );
    // Bottom-up proof: the day sidecar is written BEFORE the parent.
    const dayIdx = first.written.findIndex((p) => p === path.join(dayDir, DIRECTORY_SIDECAR_BASENAME));
    const parentIdx = first.written.findIndex(
      (p) => p === path.join(monthParent, DIRECTORY_SIDECAR_BASENAME),
    );
    assert.ok(dayIdx < parentIdx, "child sidecar written before parent");

    const daySidecar = await readFile(path.join(dayDir, DIRECTORY_SIDECAR_BASENAME), "utf8");
    assert.ok(daySidecar.startsWith(DIRECTORY_SIDECAR_MARKER));
    assert.match(daySidecar, /Telescope calibration/);
    // The parent embeds the child directory's abstract.
    const parentSidecar = await readFile(path.join(monthParent, DIRECTORY_SIDECAR_BASENAME), "utf8");
    assert.match(parentSidecar, /2026-01-02/);

    const second = await runDirectorySidecarMaintenance(root, true);
    assert.deepEqual(second.written, [], "unchanged directories are skipped");
    assert.deepEqual(second.removed, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("overview query answers from the sidecar without reading child memory files", async (t) => {
  const root = store();
  try {
    const dayDir = path.join(root, "facts", "2026-01-02");
    await writeMemory(root, "facts/2026-01-02/fact-1.md", "Telescope calibration log for the north dome.");
    await writeMemory(root, "facts/2026-01-02/fact-2.md", "Mirror alignment drift measured at 3 arcmin.");
    await writeMemory(root, "entities/crew-1.md", "Catering roster for the base kitchen.");
    await runDirectorySidecarMaintenance(root, true);

    const matches = await findDirectorySidecarsForQuery(root, "telescope calibration");
    assert.ok(matches.length >= 1, "query finds a directory via its sidecar");
    assert.equal(path.dirname(matches[0].dir), path.join(root, "facts"));
    assert.match(matches[0].abstract, /Telescope/i);
    // Catering directory must not outrank the telescope directory.
    assert.ok(!matches.some((m) => m.dir === path.join(root, "entities")));

    // Strong proof no child file content was read: make children unreadable
    // (stat still works, so freshness holds) and query again.
    if (process.getuid && process.getuid() === 0) {
      t.skip("chmod proof skipped under root");
    } else {
      for (const name of await readdir(dayDir)) {
        if (name.endsWith(".md") && name !== DIRECTORY_SIDECAR_BASENAME) {
          chmodSync(path.join(dayDir, name), 0o000);
        }
      }
      try {
        const stillMatches = await findDirectorySidecarsForQuery(root, "mirror alignment");
        assert.ok(stillMatches.length >= 1);
        assert.match(stillMatches[0].overview, /Mirror alignment/);
      } finally {
        for (const name of await readdir(dayDir)) {
          if (name.endsWith(".md") && name !== DIRECTORY_SIDECAR_BASENAME) {
            chmodSync(path.join(dayDir, name), 0o644);
          }
        }
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adding a file invalidates the sidecar and refresh refreshes it deterministically", async () => {
  const root = store();
  try {
    const dayDir = path.join(root, "facts", "2026-01-02");
    await writeMemory(root, "facts/2026-01-02/fact-1.md", "Boiler pressure nominal.");
    await runDirectorySidecarMaintenance(root, true);

    const before = await loadDirectorySidecar(dayDir, { refresh: false });
    assert.equal(before?.fresh, true, "sidecar is fresh right after maintenance");

    await writeMemory(root, "facts/2026-01-02/fact-2.md", "Coolant pump replaced with spare unit.");

    const stale = await loadDirectorySidecar(dayDir, { refresh: false });
    assert.equal(stale?.fresh, false, "adding a file marks the sidecar stale");

    // Eager maintenance rewrites the stale sidecar.
    const report = await runDirectorySidecarMaintenance(root, true);
    assert.ok(
      report.written.some((p) => p === path.join(dayDir, DIRECTORY_SIDECAR_BASENAME)),
      "stale sidecar rewritten by maintenance",
    );
    const afterEager = await loadDirectorySidecar(dayDir, { refresh: false });
    assert.equal(afterEager?.fresh, true);
    assert.match(afterEager?.overview ?? "", /Coolant pump/);

    // Lazy refresh also converges after a later direct write, with no maintenance run.
    await writeMemory(root, "facts/2026-01-02/fact-3.md", "Thruster gimbal recalibrated.");
    const lazilyRefreshed = await loadDirectorySidecar(dayDir);
    assert.equal(lazilyRefreshed?.fresh, true);
    assert.match(lazilyRefreshed?.overview ?? "", /Thruster gimbal/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deleting a child updates the parent and prunes emptied directories", async () => {
  const root = store();
  try {
    const dayDir = path.join(root, "facts", "2026-01-02");
    const fact1 = await writeMemory(root, "facts/2026-01-02/fact-1.md", "First observation run.");
    await writeMemory(root, "facts/2026-01-02/fact-2.md", "Second observation run.");
    await runDirectorySidecarMaintenance(root, true);

    rmSync(fact1);
    const report = await runDirectorySidecarMaintenance(root, true);
    const daySidecar = await readFile(path.join(dayDir, DIRECTORY_SIDECAR_BASENAME), "utf8");
    assert.doesNotMatch(daySidecar, /First observation/, "deleted child leaves the sidecar");
    assert.match(daySidecar, /Second observation/);
    assert.ok(
      report.written.some((p) => p === path.join(dayDir, DIRECTORY_SIDECAR_BASENAME)),
      "child deletion rewrites the day sidecar",
    );
    assert.ok(
      report.written.some((p) => p === path.join(root, "facts", DIRECTORY_SIDECAR_BASENAME)),
      "child deletion propagates to the parent sidecar",
    );

    for (const name of await readdir(dayDir)) {
      if (name.endsWith(".md") && name !== DIRECTORY_SIDECAR_BASENAME) {
        rmSync(path.join(dayDir, name));
      }
    }
    const pruned = await runDirectorySidecarMaintenance(root, true);
    assert.ok(
      pruned.removed.some((p) => p === path.join(dayDir, DIRECTORY_SIDECAR_BASENAME)),
      "emptied directory loses its sidecar",
    );
    assert.equal(await exists(path.join(dayDir, DIRECTORY_SIDECAR_BASENAME)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("namespace scoping: lookup stays inside the requested namespace", async () => {
  const root = store();
  try {
    await writeMemory(root, "namespaces/alpha/facts/2026-05-01/a-1.md", "Alpha wing telescope mirror audit.");
    await writeMemory(root, "namespaces/beta/facts/2026-05-01/b-1.md", "Beta wing telescope mirror audit.");
    const report = await runDirectorySidecarMaintenance(root, true);
    assert.ok(report.written.some((p) => p.includes(path.join("alpha", "facts", "2026-05-01"))));
    assert.ok(report.written.some((p) => p.includes(path.join("beta", "facts", "2026-05-01"))));

    const scoped = await findDirectorySidecarsForQuery(root, "telescope mirror", { namespace: "beta" });
    assert.ok(scoped.length >= 1);
    const betaRoot = path.join(root, "namespaces", "beta");
    assert.ok(
      scoped.every((m) => {
        const r = path.relative(betaRoot, m.dir);
        return r !== "" && !r.startsWith("..") && !path.isAbsolute(r);
      }),
      "no hit may escape the requested namespace",
    );
    assert.match(scoped[0].abstract, /Beta wing/i);

    const unscoped = await findDirectorySidecarsForQuery(root, "telescope mirror");
    assert.equal(unscoped.length, 2, "unscoped query spans both namespaces");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sidecar files are excluded from generic recall but stay searchable", async () => {
  assert.equal(
    isGenericRecallExcludedPath(path.join("facts", "2026-01-02", DIRECTORY_SIDECAR_BASENAME)),
    true,
    "sidecar must never be injected as a recall memory",
  );
  assert.equal(
    isGenericRecallExcludedPath(
      path.join("namespaces", "beta", "facts", "2026-01-02", DIRECTORY_SIDECAR_BASENAME),
    ),
    true,
  );
  assert.equal(
    isSearchExcludedPath(path.join("facts", "2026-01-02", DIRECTORY_SIDECAR_BASENAME)),
    false,
    "sidecars stay full-text searchable like OKF index files",
  );
});

test("user-authored sidecar-named files are never clobbered or removed", async () => {
  const root = store();
  try {
    const factsDir = path.join(root, "facts");
    await mkdir(factsDir, { recursive: true });
    const userFile = path.join(factsDir, DIRECTORY_SIDECAR_BASENAME);
    writeFileSync(userFile, "# my own notes\n");
    await writeMemory(root, "facts/fact-1.md", "Ordinary memory.");

    const enabled = await runDirectorySidecarMaintenance(root, true);
    assert.ok(
      !enabled.written.some((p) => p === userFile),
      "user file without the marker is not overwritten",
    );
    assert.equal(await readFile(userFile, "utf8"), "# my own notes\n");

    const disabled = await runDirectorySidecarMaintenance(root, false);
    assert.ok(
      !disabled.removed.some((p) => p === userFile),
      "disabling maintenance never deletes a user file",
    );
    assert.equal(await readFile(userFile, "utf8"), "# my own notes\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
