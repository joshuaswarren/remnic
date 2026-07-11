import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildTokenEntry,
  commitTokenEntry,
  generateToken,
  getAllValidTokenEntriesCached,
  getAllValidTokensCached,
  loadTokenStore,
  revokeToken,
  saveTokenStore,
} from "./tokens.js";

async function makeTempTokenPath(): Promise<{ dir: string; tokensPath: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-tokens-"));
  return { dir, tokensPath: path.join(dir, "tokens.json") };
}

test("token mutations reject corrupt stores without overwriting them", async () => {
  const { dir, tokensPath } = await makeTempTokenPath();
  try {
    await writeFile(tokensPath, "{not json", "utf8");

    assert.throws(
      () => generateToken("codex", tokensPath),
      /failed to parse token store/,
    );
    assert.equal(await readFile(tokensPath, "utf8"), "{not json");

    assert.throws(
      () => revokeToken("codex", tokensPath),
      /failed to parse token store/,
    );
    assert.equal(await readFile(tokensPath, "utf8"), "{not json");

    assert.throws(
      () => commitTokenEntry(buildTokenEntry("codex"), tokensPath),
      /failed to parse token store/,
    );
    assert.equal(await readFile(tokensPath, "utf8"), "{not json");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadTokenStore validates token entry shape before returning tokens", async () => {
  const { dir, tokensPath } = await makeTempTokenPath();
  try {
    await writeFile(
      tokensPath,
      JSON.stringify({ tokens: [{ token: "remnic_cx_bad", connector: "" }] }),
      "utf8",
    );

    assert.throws(
      () => loadTokenStore(tokensPath),
      /connector must be a non-empty string/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadTokenStore accepts timestamp-less legacy token entries", async () => {
  const { dir, tokensPath } = await makeTempTokenPath();
  try {
    await writeFile(
      tokensPath,
      JSON.stringify({
        tokens: [
          { token: "remnic_hm_manual", connector: "hermes" },
        ],
      }),
      "utf8",
    );

    const store = loadTokenStore(tokensPath);

    assert.deepEqual(store.tokens, [
      {
        token: "remnic_hm_manual",
        connector: "hermes",
        createdAt: "1970-01-01T00:00:00.000Z",
      },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveTokenStore preserves the prior file when atomic rename fails", async () => {
  const { dir, tokensPath } = await makeTempTokenPath();
  const original = {
    tokens: [{
      token: "remnic_cx_original",
      connector: "codex",
      createdAt: "2026-05-18T00:00:00.000Z",
    }],
  };
  const replacement = {
    tokens: [{
      token: "remnic_cx_replacement",
      connector: "codex",
      createdAt: "2026-05-18T00:01:00.000Z",
    }],
  };
  await writeFile(tokensPath, `${JSON.stringify(original, null, 2)}\n`, "utf8");
  await chmod(tokensPath, 0o600);

  const renameSync = fs.renameSync;
  (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = () => {
    throw new Error("simulated rename failure");
  };
  try {
    assert.throws(
      () => saveTokenStore(replacement, tokensPath),
      /simulated rename failure/,
    );
  } finally {
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = renameSync;
  }

  assert.deepEqual(JSON.parse(await readFile(tokensPath, "utf8")), original);
  const leftovers = (await readdir(dir)).filter((name) => name.includes(".tmp"));
  assert.deepEqual(leftovers, []);
  assert.equal((await stat(tokensPath)).mode & 0o777, 0o600);
});

test("legacy flat token stores migrate without dropping tokens", async () => {
  const { dir, tokensPath } = await makeTempTokenPath();
  try {
    await writeFile(
      tokensPath,
      JSON.stringify({
        codex: "remnic_cx_legacy",
        hermes: "remnic_hm_legacy",
      }),
      "utf8",
    );

    const store = loadTokenStore(tokensPath);
    assert.deepEqual(
      store.tokens.map((entry) => [entry.connector, entry.token]).sort(),
      [
        ["codex", "remnic_cx_legacy"],
        ["hermes", "remnic_hm_legacy"],
      ],
    );

    const migrated = JSON.parse(await readFile(tokensPath, "utf8"));
    assert.equal(Array.isArray(migrated.tokens), true);
    assert.equal(migrated.tokens.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy flat token stores reject empty connector keys before returning tokens", async () => {
  const { dir, tokensPath } = await makeTempTokenPath();
  try {
    await writeFile(
      tokensPath,
      JSON.stringify({
        "": "remnic_cx_invalid",
      }),
      "utf8",
    );

    assert.throws(
      () => loadTokenStore(tokensPath),
      /connector must be a non-empty string/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("token writes invalidate the cached valid-token list", async () => {
  const { dir, tokensPath } = await makeTempTokenPath();
  try {
    const entry = generateToken("codex", tokensPath);
    assert.deepEqual(getAllValidTokensCached(tokensPath), [entry.token]);

    assert.equal(revokeToken("codex", tokensPath), true);
    assert.deepEqual(getAllValidTokensCached(tokensPath), []);

    const replacement = buildTokenEntry("codex");
    commitTokenEntry(replacement, tokensPath);
    assert.deepEqual(getAllValidTokensCached(tokensPath), [replacement.token]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("generateToken uses a recognizable prefix for the omp connector", async () => {
  const { dir, tokensPath } = await makeTempTokenPath();
  try {
    const entry = generateToken("omp", tokensPath);
    assert.equal(entry.connector, "omp");
    assert.ok(
      entry.token.startsWith("remnic_op_"),
      `expected remnic_op_ prefix, got ${entry.token}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("generateToken uses a recognizable prefix for the chatgpt connector", async () => {
  const { dir, tokensPath } = await makeTempTokenPath();
  try {
    const entry = generateToken("chatgpt", tokensPath);
    assert.equal(entry.connector, "chatgpt");
    assert.ok(
      entry.token.startsWith("remnic_cg_"),
      `expected remnic_cg_ prefix, got ${entry.token}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("commitTokenEntry replaces the prior chatgpt entry so re-linking rotates the token", async () => {
  const { dir, tokensPath } = await makeTempTokenPath();
  try {
    const first = generateToken("chatgpt", tokensPath);
    commitTokenEntry(first, tokensPath);
    const second = generateToken("chatgpt", tokensPath);
    commitTokenEntry(second, tokensPath);
    assert.notEqual(first.token, second.token, "re-linking must mint a new token");
    const store = loadTokenStore(tokensPath);
    const chatgptEntries = store.tokens.filter((t) => t.connector === "chatgpt");
    assert.equal(chatgptEntries.length, 1, "only one chatgpt entry survives the rotate");
    assert.equal(chatgptEntries[0]?.token, second.token, "the new token is the surviving one");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("entries snapshot is coherent with validation: mint and revoke take effect immediately", async () => {
  const { dir, tokensPath } = await makeTempTokenPath();
  try {
    // Warm the cache so a stale snapshot WOULD be observable if mutation
    // failed to invalidate it.
    assert.deepEqual([...getAllValidTokenEntriesCached(tokensPath)], []);

    // Mint-then-use: the fresh token resolves with its connector in the
    // SAME snapshot call that validates it — no window where the token is
    // valid but its identity is unknown.
    const minted = generateToken("chatgpt", tokensPath);
    const afterMint = getAllValidTokenEntriesCached(tokensPath);
    const found = afterMint.find((entry) => entry.token === minted.token);
    assert.ok(found, "freshly minted token must appear immediately");
    assert.equal(found.connector, "chatgpt");
    assert.deepEqual(getAllValidTokensCached(tokensPath), [minted.token]);

    // Revoke-then-use: the token disappears from the snapshot immediately.
    assert.equal(revokeToken("chatgpt", tokensPath), true);
    assert.deepEqual([...getAllValidTokenEntriesCached(tokensPath)], []);
    assert.deepEqual(getAllValidTokensCached(tokensPath), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
