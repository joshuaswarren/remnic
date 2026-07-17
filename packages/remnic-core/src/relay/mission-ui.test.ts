import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { EngramAccessHttpServer } from "../access-http.js";
import type { EngramAccessService } from "../access-service.js";
import type { StorageManager } from "../storage.js";

const adminConsolePublicDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../admin-console/public"
);

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-relay-ui-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fakeService(root: string): EngramAccessService {
  const storage = { dir: root } as StorageManager;
  return {
    configRef: { defaultNamespace: "relay-build-week", namespacesEnabled: true },
    getReadableStorageForNamespace: async (namespace?: string) => ({ namespace: namespace ?? "relay-build-week", storage }),
    getWritableStorageForNamespace: async (namespace?: string) => ({ namespace: namespace ?? "relay-build-week", storage }),
  } as unknown as EngramAccessService;
}

test("Relay Mission Control serves both aliases from one exact static allow-list", async () => {
  await withTempRoot(async (root) => {
    const server = new EngramAccessHttpServer({
      service: fakeService(root),
      host: "127.0.0.1",
      port: 0,
      authToken: "relay-token",
      principal: "relay-operator",
      adminConsoleEnabled: true,
      adminConsolePublicDir,
      adminConsolePrefillToken: true,
    });
    const status = await server.start();
    const origin = `http://127.0.0.1:${status.port}`;
    try {
      for (const prefix of ["remnic", "engram"]) {
        const redirect = await fetch(`${origin}/${prefix}/ui/relay`, { redirect: "manual" });
        assert.equal(redirect.status, 301);
        assert.equal(redirect.headers.get("location"), `/${prefix}/ui/relay/`);

        const shell = await fetch(`${origin}/${prefix}/ui/relay/`);
        assert.equal(shell.status, 200);
        assert.match(shell.headers.get("content-type") ?? "", /^text\/html/);
        assert.doesNotMatch(await shell.text(), /__REMNIC_ADMIN_CONSOLE_PREFILL_TOKEN__/);

        const authorizedShell = await fetch(`${origin}/${prefix}/ui/relay/`, {
          headers: { authorization: "Bearer relay-token" },
        });
        assert.equal(authorizedShell.status, 200);
        assert.equal(authorizedShell.headers.get("cache-control"), "private, no-store");
        assert.match(await authorizedShell.text(), /__REMNIC_ADMIN_CONSOLE_PREFILL_TOKEN__="relay-token"/);

        const expectedAssets = new Map([
          ["relay.css", /^text\/css/],
          ["relay-model.js", /^application\/javascript/],
          ["relay.js", /^application\/javascript/],
          ["replay.json", /^application\/json/],
        ]);
        for (const [fileName, contentType] of expectedAssets) {
          const asset = await fetch(`${origin}/${prefix}/ui/relay/${fileName}`);
          assert.equal(asset.status, 200, `${prefix}/${fileName}`);
          assert.match(asset.headers.get("content-type") ?? "", contentType);
          assert.ok((await asset.text()).length > 100);
        }

        const auth = { authorization: "Bearer relay-token" };
        const unknown = await fetch(`${origin}/${prefix}/ui/relay/not-allowed.js`, { headers: auth });
        assert.equal(unknown.status, 404);
        const nested = await fetch(`${origin}/${prefix}/ui/relay/relay.js/extra`, { headers: auth });
        assert.equal(nested.status, 404);
      }
    } finally {
      await server.stop();
    }
  });
});
