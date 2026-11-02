/**
 * Regression: amortized completion must refuse a symlinked entities root
 * before getFingerprint → fingerprintEntityEntries readdir.
 *
 * inputSig already labels the root "L", but isCompleted still runs the full
 * fingerprint (external tree walk) before any isTrustedEntitiesRoot-style
 * guard. A planted complete journal makes that path reachable after a
 * missing-id ENOENT.
 *
 * Instrumentation: canary dir mode 000. Any readdir of the external tree
 * surfaces EACCES. The security property is "no throw / no enumeration",
 * not "empty content". Temp roots only — no real user directories.
 *
 * Expected today: RED (EACCES from external readdir).
 * After root nofollow guard: completed === false, no EACCES.
 */
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isErrnoCode } from "../utils/errno.js";
import { ENTITY_CANONICAL_ID_MIGRATION_FILE } from "./entity-canonical-id-references.js";
import { EntityMigrationCompletionCache } from "./entity-migration-completion-cache.js";
import { getFingerprint } from "./entity-canonical-id-migration.js";

test("isCompleted must not readdir through a symlinked entities root", async () => {
  // Root bypasses mode bits; EACCES instrumentation would be meaningless.
  if (process.getuid?.() === 0) return;

  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-entities-root-nofollow-"));
  const memoryDir = path.join(root, "memory");
  const canaryDir = path.join(root, "canary-external");
  const entitiesDir = path.join(memoryDir, "entities");
  const stateDir = path.join(memoryDir, "state");

  try {
    await mkdir(memoryDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await mkdir(path.join(memoryDir, "config"), { recursive: true });
    await mkdir(canaryDir, { recursive: true });
    // Distinct external entry so a full fingerprint walk has something to list.
    await writeFile(path.join(canaryDir, "outside-only.md"), "canary external entity body\n");

    await symlink(canaryDir, entitiesDir);
    assert.equal(
      (await lstat(entitiesDir)).isSymbolicLink(),
      true,
      "fixture: entities/ must be a symlink to the external canary",
    );

    // Regular complete journal — completionFingerprint compare invokes getFingerprint.
    await writeFile(
      path.join(stateDir, ENTITY_CANONICAL_ID_MIGRATION_FILE),
      JSON.stringify({
        version: 1,
        complete: true,
        mappings: {},
        completionFingerprint: "planted-complete-journal-for-symlink-root-regression",
      }),
    );

    // Instrument the fingerprint readdir seam: lock the external tree.
    // EACCES is proof the walk crossed the symlink; a root guard never opens it.
    await chmod(canaryDir, 0o000);

    const deps = {
      baseDir: memoryDir,
      entitiesDir,
      getEntityMutationVersion: () => 0,
    };
    const cache = new EntityMigrationCompletionCache();

    // Seam probe (documents current leak shape for the parent RED log).
    // Not a pass condition — the security assert below is.
    let seamCode: string | undefined;
    try {
      await getFingerprint(memoryDir, entitiesDir, () => "0");
    } catch (err) {
      seamCode = isErrnoCode(err, "EACCES") ? "EACCES" : isErrnoCode(err, "EPERM") ? "EPERM" : undefined;
      if (seamCode === undefined) throw err;
    }

    let completed: boolean | undefined;
    let enumerationErr: unknown;
    try {
      completed = await cache.isCompleted(deps);
    } catch (err) {
      enumerationErr = err;
    }

    assert.equal(
      enumerationErr,
      undefined,
      [
        "isCompleted must refuse a symlinked entities root before fingerprintEntityEntries readdir.",
        "EACCES/EPERM on the locked canary means the external tree was enumerated.",
        seamCode ? `getFingerprint seam observed ${seamCode} on the same fixture.` : "getFingerprint seam did not throw.",
        enumerationErr instanceof Error
          ? `isCompleted threw: ${(enumerationErr as NodeJS.ErrnoException).code ?? enumerationErr.message}`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
    assert.equal(completed, false, "untrusted entities root must not report migration complete");
  } finally {
    try {
      await chmod(canaryDir, 0o700);
    } catch {
      // best-effort so rm can collect the tree
    }
    await rm(root, { recursive: true, force: true });
  }
});
