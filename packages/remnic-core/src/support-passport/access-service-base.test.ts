import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EngramAccessForbiddenError } from "../access-errors.js";
import { tokenCapabilityStore } from "../access-token-capabilities.js";
import { parseConfig } from "../config.js";
import { StorageManager } from "../storage.js";
import { SupportPassportAccessServiceBase } from "./access-service-base.js";
import type { SupportPassportModelRoute } from "./model-adapter.js";

test("support passport stays disabled when a partial host config omits its settings", async () => {
  class TestService extends SupportPassportAccessServiceBase {
    readonly configRef = {} as ReturnType<typeof parseConfig>;
    readonly localLlmRef = null;

    async getWritableStorageForNamespace(): Promise<never> {
      throw new Error("not used");
    }

    async getStorageForResolvedNamespace(): Promise<never> {
      throw new Error("not used");
    }
  }

  const service = new TestService();
  assert.equal(service.supportPassportEnabled, false);
  await assert.rejects(service.supportPassportListCards("owner:alice"), /Support passport is disabled/);
  await assert.rejects(service.supportPassportReadGrant("grant", "secret"), /share link was not found/);
});

test("support passport stays unavailable when private file pinning is unsupported", async () => {
  class TestService extends SupportPassportAccessServiceBase {
    readonly configRef = parseConfig({ supportPassport: { enabled: true } });
    readonly localLlmRef = null;

    override get supportPassportPlatformRef(): NodeJS.Platform {
      return "win32";
    }

    async getWritableStorageForNamespace(): Promise<never> {
      throw new Error("owner resolution must not run");
    }

    async getStorageForResolvedNamespace(): Promise<never> {
      throw new Error("namespace resolution must not run");
    }
  }

  const service = new TestService();
  assert.equal(service.supportPassportEnabled, false);
  await assert.rejects(service.supportPassportListCards("owner:alice"), /Support passport is disabled/);
  await assert.rejects(service.supportPassportReadGrant("grant", "secret"), /share link was not found/);
});

test("support passport owner operations enforce the presenting token namespace", async () => {
  StorageManager.clearAllStaticCaches();
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-scope-"));
  try {
    const storage = new StorageManager(path.join(root, "owner"));
    await storage.ensureDirectories();
    class TestService extends SupportPassportAccessServiceBase {
      readonly configRef = parseConfig({
        memoryDir: root,
        defaultNamespace: "default",
        supportPassport: { enabled: true },
      });
      readonly localLlmRef = null;

      async getWritableStorageForNamespace(_namespace?: string, principal?: string) {
        return { principal: principal ?? "system", namespace: "owner", storage };
      }

      async getStorageForResolvedNamespace() {
        return storage;
      }
    }
    const service = new TestService();

    await assert.rejects(
      tokenCapabilityStore.run({ version: 1, namespaces: ["other"] }, () =>
        service.supportPassportListCards("owner:alice")
      ),
      EngramAccessForbiddenError
    );
    assert.deepEqual(
      await tokenCapabilityStore.run({ version: 1, namespaces: ["owner"] }, () =>
        service.supportPassportListCards("owner:alice")
      ),
      []
    );
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("support passport preserves every configured default namespace identity", async () => {
  StorageManager.clearAllStaticCaches();
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-default-namespace-"));
  try {
    const storage = new StorageManager(path.join(root, "owner"));
    await storage.ensureDirectories();
    class TestService extends SupportPassportAccessServiceBase {
      readonly configRef = parseConfig({
        memoryDir: root,
        defaultNamespace: "team../support\\care]primary",
        supportPassport: { enabled: true },
      });
      readonly localLlmRef = null;

      async getWritableStorageForNamespace(_namespace?: string, principal?: string) {
        return {
          principal: principal ?? "system",
          namespace: this.configRef.defaultNamespace,
          storage,
        };
      }

      async getStorageForResolvedNamespace() {
        return storage;
      }
    }

    assert.deepEqual(await new TestService().supportPassportListCards("owner:alice"), []);
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("support passport access uses a host-injected gateway route without a direct API key", async () => {
  StorageManager.clearAllStaticCaches();
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-gateway-"));
  try {
    const storage = new StorageManager(path.join(root, "owner"));
    await storage.ensureDirectories();
    const source = await storage.writeMemory("preference", "Tell me before plans change.", { source: "test" });
    const route: SupportPassportModelRoute = {
      kind: "gateway",
      invoke: async () => ({
        modelUsed: "gateway/local-model",
        content: JSON.stringify({
          cards: [
            {
              title: "Plan changes",
              statement: "Tell me before plans change.",
              category: "transitions",
              sourceMemoryIds: [source.id],
            },
          ],
        }),
      }),
    };
    class TestService extends SupportPassportAccessServiceBase {
      readonly configRef = parseConfig({
        memoryDir: root,
        modelSource: "gateway",
        openaiApiKey: false,
        supportPassport: { enabled: true },
      });
      readonly localLlmRef = null;
      override get supportPassportGatewayRouteRef() {
        return route;
      }

      async getWritableStorageForNamespace(_namespace?: string, principal?: string) {
        return { principal: principal ?? "system", namespace: "owner", storage };
      }

      async getStorageForResolvedNamespace() {
        return storage;
      }
    }
    const service = new TestService();
    const preview = await service.supportPassportPreviewMemory("owner:alice", source.id);
    assert.equal(preview.found, true);
    if (!preview.found) throw new Error("source preview was not found");

    const cards = await service.supportPassportGenerateDrafts("owner:alice", {
      sourceMemoryIds: [source.id],
      sourceMemoryRevisions: [{ memoryId: source.id, revision: preview.memory.revision }],
      consent: true,
    });

    assert.equal(cards[0]?.title, "Plan changes");
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
