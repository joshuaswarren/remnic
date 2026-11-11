import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { EngramAccessInputError } from "./access-errors.js";
import { EngramAccessService } from "./access-service.js";
import { defaultCapsulesDir } from "./capsule-cli.js";
import { parseConfig } from "./config.js";
import { NamespaceStorageRouter } from "./namespaces/storage.js";
import type { Orchestrator } from "./orchestrator.js";
import { generateSalt } from "./secure-store/cipher.js";
import { buildHeaderFromPassphrase, writeHeader, secureStoreDir } from "./secure-store/header.js";
import * as keyring from "./secure-store/keyring.js";
import type { ScryptParams } from "./secure-store/kdf.js";

/**
 * Capsule import source confinement (issue #3225 C1): a remote import may
 * only read an archive that lives inside the destination namespace's capsule
 * store, the same store `capsule export` writes and `capsule_list` lists.
 */

const FAST_SCRYPT: ScryptParams = {
  N: 1 << 10,
  r: 8,
  p: 1,
  keyLength: 32,
  maxmem: 64 * 1024 * 1024,
};

const TEST_PASSPHRASE = "capsule-confinement-passphrase";

/** Initialize a secure-store header in `memoryDir` and unlock its keyring. */
async function initAndUnlockStore(memoryDir: string): Promise<void> {
  const salt = generateSalt();
  const { header, derivedKey } = buildHeaderFromPassphrase({
    passphrase: TEST_PASSPHRASE,
    salt,
    algorithm: "scrypt",
    params: FAST_SCRYPT,
  });
  await writeHeader(memoryDir, header);
  const keyCopy = Buffer.from(derivedKey);
  keyring.unlock(secureStoreDir(memoryDir), keyCopy);
}

interface Fixture {
  memoryDir: string;
  service: EngramAccessService;
  storageRouter: NamespaceStorageRouter;
}

/** Real service over real namespace storage; the capsule paths touch only config and getStorage. */
async function createFixture(t: TestContext): Promise<Fixture> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-capsule-import-"));
  t.after(() => rm(memoryDir, { recursive: true, force: true }));
  const config = parseConfig({
    memoryDir,
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [
      { name: "default", readPrincipals: ["owner"], writePrincipals: ["owner"] },
      { name: "foreign", readPrincipals: ["owner"], writePrincipals: ["owner"] },
    ],
  });
  const storageRouter = new NamespaceStorageRouter(config);
  const storage = await storageRouter.storageFor("default");
  await mkdir(path.join(storage.dir, "facts"), { recursive: true });
  await writeFile(path.join(storage.dir, "facts", "seeded.md"), "---\nid: fact-seeded\n---\nSeeded fact body.");
  const dependencies: Pick<Orchestrator, "config" | "getStorage"> = {
    config,
    getStorage: (namespace) => storageRouter.storageFor(namespace ?? config.defaultNamespace),
  };
  // SAFETY: the capsule paths touch only `config` and `getStorage` (the Pick above); the rest of the Orchestrator is unused here.
  return { memoryDir, service: new EngramAccessService(dependencies as Orchestrator), storageRouter };
}

const REFUSAL = /capsule import failed: archivePath must be an existing file inside the namespace capsule store/;

test("capsule import refuses an archive outside the namespace capsule store", async (t) => {
  const { memoryDir, service } = await createFixture(t);
  const exported = await service.capsuleExport({ name: "relocation", namespace: "default", principal: "owner" });
  const outsideArchive = path.join(path.dirname(defaultCapsulesDir(memoryDir)), "outside.capsule.json.gz");
  await mkdir(path.dirname(outsideArchive), { recursive: true });
  await writeFile(outsideArchive, await readFile(exported.archivePath));
  try {
    await assert.rejects(
      () => service.capsuleImport({ archivePath: outsideArchive, namespace: "default", principal: "owner" }),
      REFUSAL,
    );
    // A `..` segment that walks out of the store resolves to the same outside file.
    await assert.rejects(
      () =>
        service.capsuleImport({
          archivePath: path.join(defaultCapsulesDir(memoryDir), "..", "outside.capsule.json.gz"),
          namespace: "default",
          principal: "owner",
        }),
      REFUSAL,
    );
  } finally {
    await rm(outsideArchive, { force: true });
  }
});

test("capsule import refuses an archive in another namespace's capsule store", async (t) => {
  const { service, storageRouter } = await createFixture(t);
  const exported = await service.capsuleExport({ name: "cross-principal", namespace: "default", principal: "owner" });
  const foreignStorage = await storageRouter.storageFor("foreign");
  const foreignStore = defaultCapsulesDir(foreignStorage.dir);
  await mkdir(foreignStore, { recursive: true });
  const foreignArchive = path.join(foreignStore, "cross-principal.capsule.json.gz");
  await writeFile(foreignArchive, await readFile(exported.archivePath));
  try {
    await assert.rejects(
      () => service.capsuleImport({ archivePath: foreignArchive, namespace: "default", principal: "owner" }),
      REFUSAL,
    );
  } finally {
    await rm(foreignArchive, { force: true });
  }
});

test("capsule import refuses a store symlink that points outside", async (t) => {
  const { memoryDir, service } = await createFixture(t);
  const exported = await service.capsuleExport({ name: "symlinked", namespace: "default", principal: "owner" });
  const outsideArchive = path.join(path.dirname(defaultCapsulesDir(memoryDir)), "outside.capsule.json.gz");
  await mkdir(path.dirname(outsideArchive), { recursive: true });
  await writeFile(outsideArchive, await readFile(exported.archivePath));
  const linkedPath = path.join(defaultCapsulesDir(memoryDir), "linked.capsule.json.gz");
  await symlink(outsideArchive, linkedPath);
  try {
    await assert.rejects(
      () => service.capsuleImport({ archivePath: linkedPath, namespace: "default", principal: "owner" }),
      REFUSAL,
    );
  } finally {
    await rm(linkedPath, { force: true });
    await rm(outsideArchive, { force: true });
  }
});

test("capsule import refuses a missing namespace capsule store", async (t) => {
  const { memoryDir, service } = await createFixture(t);
  const exported = await service.capsuleExport({ name: "nosuchstore", namespace: "default", principal: "owner" });
  const outsideArchive = path.join(path.dirname(defaultCapsulesDir(memoryDir)), "outside.capsule.json.gz");
  await mkdir(path.dirname(outsideArchive), { recursive: true });
  await writeFile(outsideArchive, await readFile(exported.archivePath));
  await rm(defaultCapsulesDir(memoryDir), { recursive: true, force: true });
  try {
    await assert.rejects(
      () => service.capsuleImport({ archivePath: outsideArchive, namespace: "default", principal: "owner" }),
      REFUSAL,
    );
  } finally {
    await rm(outsideArchive, { force: true });
  }
});

test("capsule import gives the same refusal for every outside path, whatever the path holds", async (t) => {
  const { memoryDir, service } = await createFixture(t);
  const outsideDir = path.join(memoryDir, "outside-dir");
  await mkdir(outsideDir, { recursive: true });
  const presentFile = path.join(outsideDir, "present.capsule.json.gz");
  await writeFile(presentFile, "not an archive");
  const loop = path.join(outsideDir, "loop");
  await symlink(loop, loop);
  const candidates = [
    presentFile,
    path.join(outsideDir, "absent.capsule.json.gz"),
    outsideDir,
    loop,
    path.join(presentFile, "below-a-file"),
    `${presentFile}\0suffix`,
    path.join(os.tmpdir(), "remnic-capsule-import-no-such-dir", "x.capsule.json.gz"),
  ];
  const messages = new Set<string>();
  for (const archivePath of candidates) {
    await assert.rejects(
      () => service.capsuleImport({ archivePath, namespace: "default", principal: "owner" }),
      (err) => {
        assert.ok(err instanceof EngramAccessInputError);
        messages.add(err.message);
        return true;
      },
    );
  }
  assert.equal(messages.size, 1, `refusal messages differ: ${[...messages].join(" | ")}`);
  assert.match([...messages][0] ?? "", REFUSAL);
});

test("export, list, and import of the listed archivePath round-trips a plain archive", async (t) => {
  const { service, storageRouter } = await createFixture(t);
  await service.capsuleExport({ name: "roundtrip", namespace: "default", principal: "owner" });
  const list = await service.capsuleList({ namespace: "default", principal: "owner" });
  const entry = list.capsules[0];
  assert.ok(entry, "capsule_list must return the exported archive");
  const storage = await storageRouter.storageFor("default");
  // Restore after loss: drop the seeded file so the import must write it back.
  await rm(path.join(storage.dir, "facts", "seeded.md"), { force: true });
  const imported = await service.capsuleImport({ archivePath: entry.archivePath, namespace: "default", principal: "owner" });
  assert.equal(imported.imported.length, 1);
  assert.equal(imported.skipped.length, 0);
  const landing = imported.imported[0];
  assert.ok(landing, "the seeded fact must be reported as imported");
  const body = await readFile(path.join(storage.dir, landing.targetPath), "utf-8");
  assert.match(body, /Seeded fact body\./);
});

test("export, list, and import of the listed archivePath round-trips an encrypted archive", async (t) => {
  const { memoryDir, service, storageRouter } = await createFixture(t);
  await initAndUnlockStore(memoryDir);
  const exported = await service.capsuleExport({
    name: "encrypted-roundtrip",
    namespace: "default",
    principal: "owner",
    encrypt: true,
  });
  assert.match(exported.archivePath, /\.enc$/);
  const list = await service.capsuleList({ namespace: "default", principal: "owner" });
  const entry = list.capsules[0];
  assert.ok(entry, "capsule_list must return the exported encrypted archive");
  assert.equal(entry.archivePath, exported.archivePath);
  const storage = await storageRouter.storageFor("default");
  // Restore after loss: drop the seeded file so the import must write it back.
  await rm(path.join(storage.dir, "facts", "seeded.md"), { force: true });
  const imported = await service.capsuleImport({ archivePath: entry.archivePath, namespace: "default", principal: "owner" });
  assert.equal(imported.imported.length, 1);
  assert.equal(imported.skipped.length, 0);
  const landing = imported.imported[0];
  assert.ok(landing, "the seeded fact must be reported as imported");
  const body = await readFile(path.join(storage.dir, landing.targetPath), "utf-8");
  assert.match(body, /Seeded fact body\./);
});
