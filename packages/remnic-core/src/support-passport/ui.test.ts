import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { EngramAccessHttpServer, resolveDefaultAdminConsolePublicDir } from "../access-http.js";
import type { EngramAccessService } from "../access-service.js";
import type { StorageManager } from "../storage.js";

const adminConsolePublicDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../admin-console/public"
);

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-support-passport-ui-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fakeService(root: string, enabled: boolean): EngramAccessService {
  const storage = { dir: root } as StorageManager;
  return {
    supportPassportEnabled: enabled,
    configRef: { defaultNamespace: "support-passport", namespacesEnabled: true },
    getReadableStorageForNamespace: async () => ({ namespace: "support-passport", storage }),
    getWritableStorageForNamespace: async () => ({ namespace: "support-passport", storage }),
  } as unknown as EngramAccessService;
}

test("What Helps Me serves both aliases from one exact feature-gated allow-list", async () => {
  await withTempRoot(async (root) => {
    const server = new EngramAccessHttpServer({
      service: fakeService(root, true),
      host: "127.0.0.1",
      port: 0,
      authToken: "owner-token",
      principal: "support-passport-owner",
      adminConsoleEnabled: false,
      adminConsolePublicDir,
      adminConsolePrefillToken: true,
    });
    const status = await server.start();
    const origin = `http://127.0.0.1:${status.port}`;
    try {
      for (const prefix of ["remnic", "engram"]) {
        const redirect = await fetch(`${origin}/${prefix}/ui/what-helps-me`, { redirect: "manual" });
        assert.equal(redirect.status, 301);
        assert.equal(redirect.headers.get("location"), `/${prefix}/ui/what-helps-me/`);
        const redirectWithGrant = await fetch(`${origin}/${prefix}/ui/what-helps-me?grant=grant-one&mode=replay`, {
          redirect: "manual",
        });
        assert.equal(
          redirectWithGrant.headers.get("location"),
          `/${prefix}/ui/what-helps-me/?grant=grant-one&mode=replay`
        );

        const shell = await fetch(`${origin}/${prefix}/ui/what-helps-me/`);
        assert.equal(shell.status, 200);
        assert.match(shell.headers.get("content-type") ?? "", /^text\/html/);
        assert.doesNotMatch(await shell.text(), /__REMNIC_ADMIN_CONSOLE_PREFILL_TOKEN__/);

        const authorizedShell = await fetch(`${origin}/${prefix}/ui/what-helps-me/`, {
          headers: { authorization: "Bearer owner-token" },
        });
        assert.equal(authorizedShell.status, 200);
        assert.equal(authorizedShell.headers.get("cache-control"), "private, no-store");
        assert.match(await authorizedShell.text(), /__REMNIC_ADMIN_CONSOLE_PREFILL_TOKEN__="owner-token"/);

        const expectedAssets = new Map([
          ["what-helps-me.css", /^text\/css/],
          ["model.js", /^application\/javascript/],
          ["app.js", /^application\/javascript/],
        ]);
        for (const [fileName, contentType] of expectedAssets) {
          const asset = await fetch(`${origin}/${prefix}/ui/what-helps-me/${fileName}`);
          assert.equal(asset.status, 200, `${prefix}/${fileName}`);
          assert.match(asset.headers.get("content-type") ?? "", contentType);
          assert.ok((await asset.text()).length > 100);
        }

        const unknown = await fetch(`${origin}/${prefix}/ui/what-helps-me/not-allowed.js`);
        assert.equal(unknown.status, 404);
        const nested = await fetch(`${origin}/${prefix}/ui/what-helps-me/app.js/extra`);
        assert.equal(nested.status, 404);
      }
    } finally {
      await server.stop();
    }
  });
});

test("What Helps Me finds repository assets without a source-mode path override", async () => {
  const sourceModuleUrl = new URL("../access-http.ts", import.meta.url);
  assert.equal(resolveDefaultAdminConsolePublicDir(sourceModuleUrl.href), adminConsolePublicDir);
  await withTempRoot(async (root) => {
    const server = new EngramAccessHttpServer({
      service: fakeService(root, true),
      host: "127.0.0.1",
      port: 0,
      authToken: "owner-token",
      principal: "support-passport-owner",
      adminConsoleEnabled: false,
    });
    const status = await server.start();
    try {
      const shell = await fetch(`http://127.0.0.1:${status.port}/remnic/ui/what-helps-me/`);
      assert.equal(shell.status, 200);
      assert.match(await shell.text(), /What Helps Me/);
      const asset = await fetch(`http://127.0.0.1:${status.port}/remnic/ui/what-helps-me/app.js`);
      assert.equal(asset.status, 200);
      assert.ok((await asset.text()).length > 100);
    } finally {
      await server.stop();
    }
  });
});

test("What Helps Me finds copied assets from the published source export", async () => {
  await withTempRoot(async (root) => {
    const sourceModulePath = path.join(root, "package", "src", "access-http.ts");
    const publishedAssets = path.join(root, "package", "dist", "admin-console", "public");
    await mkdir(path.dirname(sourceModulePath), { recursive: true });
    await mkdir(publishedAssets, { recursive: true });
    await writeFile(sourceModulePath, "");
    assert.equal(resolveDefaultAdminConsolePublicDir(new URL(`file://${sourceModulePath}`).href), publishedAssets);
  });
});

test("What Helps Me assets stay hidden while support passport is disabled", async () => {
  await withTempRoot(async (root) => {
    const server = new EngramAccessHttpServer({
      service: fakeService(root, false),
      host: "127.0.0.1",
      port: 0,
      authToken: "owner-token",
      principal: "support-passport-owner",
      adminConsoleEnabled: true,
      adminConsolePublicDir,
    });
    const status = await server.start();
    try {
      const response = await fetch(`http://127.0.0.1:${status.port}/remnic/ui/what-helps-me/`);
      assert.equal(response.status, 404);
    } finally {
      await server.stop();
    }
  });
});

test("What Helps Me disables the browser cache for credentialed API requests", async () => {
  const source = await readFile(path.join(adminConsolePublicDir, "what-helps-me", "app.js"), "utf8");
  assert.match(source, /fetch\(path, \{[\s\S]*?cache: "no-store"/);
});

test("What Helps Me wordmark does not depend on the optional admin console", async () => {
  const source = await readFile(path.join(adminConsolePublicDir, "what-helps-me", "index.html"), "utf8");
  assert.doesNotMatch(source, /class="wordmark"[^>]*href=/);
});
