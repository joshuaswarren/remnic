/**
 * Recall-navigation surface tests (issue #1956): MCP three-step flow
 * (recall-served id → expand → traverse), disabled-tool listing removal,
 * HTTP parity, and namespace isolation over a two-namespace fixture.
 *
 * Service is built the way deep-recall-surface.test.ts builds it:
 * Object.create(EngramAccessService.prototype) with a stub orchestrator
 * carrying a REAL RecallHandleHistoryStore (the same ring recall writes)
 * and REAL StorageManager instances.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EngramAccessHttpServer } from "./access-http.js";
import { EngramAccessService } from "./access-service.js";
import { EngramMcpServer } from "./access-mcp.js";
import type { CliCommand } from "./cli.js";
import { registerRecallNavigationCommands } from "./cli/recall-navigation-commands.js";
import { parseConfig } from "./config.js";
import { renderHandle } from "./recall-handles.js";
import { RecallHandleHistoryStore } from "./recall-state.js";
import { StorageManager } from "./storage.js";
import type { PluginConfig } from "./types.js";
import type { Orchestrator } from "./orchestrator.js";

const SESSION = "project/nav-surface/1";

interface SurfaceFixture {
  service: EngramAccessService;
  history: RecallHandleHistoryStore;
  storages: Record<string, StorageManager>;
  config: PluginConfig;
  cleanup: () => Promise<void>;
}

async function surfaceFixture(options: { namespaces?: boolean } = {}): Promise<SurfaceFixture> {
  const base = await mkdtemp(path.join(tmpdir(), "remnic-nav-surface-"));
  const nsRoot = path.join(base, "namespaces");
  if (options.namespaces) {
    await mkdir(path.join(nsRoot, "ns_alice"), { recursive: true });
    await mkdir(path.join(nsRoot, "ns_bob"), { recursive: true });
  }
  const config = parseConfig({
    memoryDir: base,
    qmdCollection: "remnic-nav-test",
    ...(options.namespaces
      ? {
          namespacesEnabled: true,
          defaultNamespace: "default",
          principalFromSessionKeyMode: "map" as const,
          principalFromSessionKeyRules: [{ match: "alice-session", principal: "alice" }],
          namespacePolicies: [
            { name: "ns_alice", readPrincipals: ["alice"], writePrincipals: ["alice"] },
            { name: "ns_bob", readPrincipals: ["bob"], writePrincipals: ["bob"] },
          ],
        }
      : {}),
  });
  const storages: Record<string, StorageManager> = options.namespaces
    ? {
        ns_alice: makeStorage(path.join(nsRoot, "ns_alice")),
        ns_bob: makeStorage(path.join(nsRoot, "ns_bob")),
      }
    : { default: makeStorage(path.join(base, "default")) };
  const history = new RecallHandleHistoryStore(base, { maxDepth: 10 });
  await history.load();
  const service = Object.create(EngramAccessService.prototype) as EngramAccessService;
  const host = service as unknown as { orchestrator: unknown };
  host.orchestrator = {
    config,
    handleHistory: history,
    async getStorage(namespace: string) {
      return storages[namespace] ?? storages.default!;
    },
  };
  return {
    service,
    history,
    storages,
    config,
    cleanup: async () => {
      StorageManager.clearAllStaticCaches();
      await rm(base, { recursive: true, force: true });
    },
  };
}

function makeStorage(dir: string): StorageManager {
  const storage = new StorageManager(dir);
  void storage.ensureDirectories();
  return storage;
}

async function writeMemory(
  storage: StorageManager,
  content: string,
  links: Array<{ targetId: string; linkType: "supports" | "contradicts" | "follows"; strength: number }> = [],
): Promise<string> {
  const result = await storage.writeMemory("fact", content, links.length > 0 ? { links } : {});
  return result.id;
}

test("MCP three-step: expand a served id to raw, then traverse contradicts", async () => {
  const f = await surfaceFixture();
  try {
    const storage = f.storages.default!;
    const neighbor = await writeMemory(storage, "The limit was raised to 2000 in the October rollout.");
    const source = await writeMemory(storage, "The API rate limit is 1000 requests per minute.", [
      { targetId: neighbor, linkType: "contradicts", strength: 0.9 },
    ]);
    // The recall step's role in the flow: register the served ids. This is
    // the same write path orchestrator recall uses (handle history record).
    await f.history.record(SESSION, [source, neighbor]);

    const server = new EngramMcpServer(f.service, { emitLegacyTools: true });
    const call = (name: string, arguments_: Record<string, unknown>) =>
      server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: arguments_ } });

    const expand = (await call("engram.memory_expand", {
      memoryId: source,
      sessionKey: SESSION,
      disclosure: "raw",
    })) as { result?: { content?: Array<{ text?: string }> }; isError?: boolean };
    const expandText = expand.result?.content?.[0]?.text ?? "";
    const expandPayload = JSON.parse(extractJson(expandText)) as {
      ok: boolean;
      items?: Array<{ content?: string; disclosure?: string }>;
    };
    assert.equal(expandPayload.ok, true);
    assert.equal(expandPayload.items?.[0]?.disclosure, "raw");
    assert.match(expandPayload.items?.[0]?.content ?? "", /1000 requests per minute/);

    const traverse = (await call("engram.memory_traverse", {
      memoryId: source,
      sessionKey: SESSION,
      relation: "contradicts",
    })) as { result?: { content?: Array<{ text?: string }> } };
    const traverseText = traverse.result?.content?.[0]?.text ?? "";
    const traversePayload = JSON.parse(extractJson(traverseText)) as {
      ok: boolean;
      items?: Array<{ memoryId?: string; linkType?: string }>;
    };
    assert.equal(traversePayload.ok, true);
    assert.equal(traversePayload.items?.length, 1);
    assert.equal(traversePayload.items?.[0]?.memoryId, neighbor);
    assert.equal(traversePayload.items?.[0]?.linkType, "contradicts");

    // An id the session never saw is refused with the constraint named.
    const stranger = await writeMemory(storage, "Never served to this session.");
    const unserved = (await call("remnic.memory_expand", {
      memoryId: stranger,
      sessionKey: SESSION,
    })) as { result?: { content?: Array<{ text?: string }> } };
    const unservedPayload = JSON.parse(
      extractJson(unserved.result?.content?.[0]?.text ?? ""),
    ) as { ok: boolean; error?: string; message?: string };
    assert.equal(unservedPayload.ok, false);
    assert.equal(unservedPayload.error, "not_served");
    assert.match(unservedPayload.message ?? "", /recall snapshots/);
  } finally {
    await f.cleanup();
  }
});

test("disabled config removes navigation tools from tools/list; default keeps them", async () => {
  const f = await surfaceFixture();
  try {
    const shortNames = async (service: unknown): Promise<ReadonlySet<string>> => {
      const server = new EngramMcpServer(service as EngramAccessService, { emitLegacyTools: true });
      const response = (await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
        result?: { tools?: Array<{ name: string }> };
      };
      const names = new Set<string>();
      for (const tool of response.result?.tools ?? []) {
        names.add(
          tool.name.replace(/^engram\./, "").replace(/^remnic_/, ""),
        );
      }
      return names;
    };

    const withFields = (fields: Record<string, unknown>): EngramAccessService =>
      // Plain object, not prototype-based: supportPassportEnabled is a
      // getter on the base class and cannot be assigned per instance. The
      // MCP constructor only READS these flags while building the tool list.
      ({
        supportPassportEnabled: false,
        briefingEnabled: false,
        ...fields,
      }) as unknown as EngramAccessService;

    const enabled = await shortNames(withFields({ recallNavigationEnabled: undefined }));
    assert.ok(enabled.has("memory_expand"), "default (flag absent) keeps memory_expand listed");
    assert.ok(enabled.has("memory_traverse"));

    const disabled = await shortNames(withFields({ recallNavigationEnabled: false }));
    assert.ok(!disabled.has("memory_expand"), "disabled removes memory_expand from listing");
    assert.ok(!disabled.has("memory_traverse"), "disabled removes memory_traverse from listing");

    // The live service shape: enabled by the default config.
    const live = await shortNames(f.service);
    assert.ok(live.has("memory_expand") && live.has("memory_traverse"));
  } finally {
    await f.cleanup();
  }
});

test("HTTP parity: POST /memory/expand and /memory/traverse share the service result", async () => {
  const f = await surfaceFixture();
  const server = new EngramAccessHttpServer({
    service: f.service,
    port: 0,
    trustPrincipalHeader: true,
    adminConsoleEnabled: false,
    authTokenEntriesGetter: () => [{ token: "operator-token", capabilities: { version: 1 } }],
  });
  try {
    const storage = f.storages.default!;
    const neighbor = await writeMemory(storage, "Supporting rollout note.");
    const source = await writeMemory(storage, "Rate limit decision.", [
      { targetId: neighbor, linkType: "supports", strength: 0.9 },
    ]);
    await f.history.record(SESSION, [source, neighbor]);
    const status = await server.start();
    const post = (pathname: string, body: Record<string, unknown>) =>
      fetch(`http://127.0.0.1:${status.port}${pathname}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer operator-token" },
        body: JSON.stringify(body),
      });

    const expand = await post("/engram/v1/memory/expand", {
      memoryId: source,
      sessionKey: SESSION,
      disclosure: "section",
    });
    assert.equal(expand.status, 200);
    const expandBody = (await expand.json()) as { ok: boolean; items?: Array<{ content?: string }> };
    assert.equal(expandBody.ok, true);
    assert.match(expandBody.items?.[0]?.content ?? "", /Rate limit decision/);

    const remnicAlias = await post("/remnic/v1/memory/traverse", {
      memoryId: source,
      sessionKey: SESSION,
      relation: "supports",
    });
    assert.equal(remnicAlias.status, 200);
    const traverseBody = (await remnicAlias.json()) as { ok: boolean; items?: Array<{ memoryId?: string }> };
    assert.equal(traverseBody.ok, true);
    assert.equal(traverseBody.items?.[0]?.memoryId, neighbor);

    const badRequest = await post("/engram/v1/memory/expand", { memoryId: source });
    assert.equal(badRequest.status, 400, "missing sessionKey is a 400 input error");
  } finally {
    await server.stop();
    await f.cleanup();
  }
});

test("namespace isolation: navigation never crosses the resolved namespace", async () => {
  const f = await surfaceFixture({ namespaces: true });
  const server = new EngramAccessHttpServer({
    service: f.service,
    port: 0,
    trustPrincipalHeader: true,
    adminConsoleEnabled: false,
    authTokenEntriesGetter: () => [{ token: "operator-token", capabilities: { version: 1 } }],
  });
  try {
    const aliceMemory = await writeMemory(
      f.storages.ns_alice!,
      "Alice-private: the merger closes on Friday.",
      [],
    );
    const bobMemory = await writeMemory(f.storages.ns_bob!, "Bob-private: the merger closes never.");
    // Alice's memory links at Bob's id (stale/foreign edge): traversal must
    // not resolve it inside alice's namespace.
    const aliceLinked = await writeMemory(f.storages.ns_alice!, "Alice decision with a foreign edge.", [
      { targetId: bobMemory, linkType: "follows", strength: 0.5 },
    ]);
    // The recall step served alice's ids to alice's session.
    await f.history.record("alice-session", [aliceMemory, aliceLinked]);

    const status = await server.start();
    const post = (body: Record<string, unknown>) =>
      fetch(`http://127.0.0.1:${status.port}/engram/v1/memory/expand`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer operator-token" },
        body: JSON.stringify(body),
      });

    // Bob asks for alice's id inside his own namespace: the id resolves
    // against bob's storage and is simply absent — zero content leakage.
    const bobProbe = await post({
      memoryId: aliceMemory,
      sessionKey: "bob-session",
      namespace: "ns_bob",
    });
    assert.equal(bobProbe.status, 200);
    const bobBody = (await bobProbe.json()) as { ok: boolean; error?: string };
    assert.equal(bobBody.ok, false);
    assert.equal(bobBody.error, "not_served", "bob's session never served alice's id");

    // Alice expands her linked memory; the foreign edge must yield no
    // neighbor content from bob's namespace.
    const aliceTraverse = await fetch(`http://127.0.0.1:${status.port}/engram/v1/memory/traverse`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer operator-token" },
      body: JSON.stringify({
        memoryId: aliceLinked,
        sessionKey: "alice-session",
        namespace: "ns_alice",
      }),
    });
    assert.equal(aliceTraverse.status, 200);
    const traverseBody = (await aliceTraverse.json()) as { ok: boolean; items?: Array<{ content?: string }> };
    assert.equal(traverseBody.ok, true);
    assert.equal(traverseBody.items?.length, 0, "foreign-namespace link target must not resolve");
    const rendered = JSON.stringify(traverseBody);
    assert.ok(!rendered.includes("Bob-private"), "no bob-namespace content may appear in alice's traverse");

    // Alice CAN expand her own served memory.
    const aliceExpand = await post({
      memoryId: aliceMemory,
      sessionKey: "alice-session",
      namespace: "ns_alice",
    });
    const aliceBody = (await aliceExpand.json()) as { ok: boolean; items?: Array<{ content?: string }> };
    assert.equal(aliceBody.ok, true);
    assert.match(aliceBody.items?.[0]?.content ?? "", /merger closes on Friday/);
  } finally {
    await server.stop();
    await f.cleanup();
  }
});

/** MCP text content embeds the JSON payload; pull it out for assertions. */
function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return "{}";
  return text.slice(start, end + 1);
}

test("MCP and HTTP resolve a documented [m:xxxx] handle", async () => {
  const f = await surfaceFixture();
  const server = new EngramAccessHttpServer({
    service: f.service,
    port: 0,
    trustPrincipalHeader: true,
    adminConsoleEnabled: false,
    authTokenEntriesGetter: () => [{ token: "operator-token", capabilities: { version: 1 } }],
  });
  try {
    const storage = f.storages.default!;
    const id = await writeMemory(storage, "Surface handle target.");
    await f.history.record(SESSION, [id]);
    const handle = renderHandle(id);

    const mcp = new EngramMcpServer(f.service, { emitLegacyTools: true });
    const mcpRes = (await mcp.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "engram.memory_expand", arguments: { memoryId: handle, sessionKey: SESSION, disclosure: "raw" } },
    })) as { result?: { content?: Array<{ text?: string }> } };
    const mcpPayload = JSON.parse(extractJson(mcpRes.result?.content?.[0]?.text ?? "")) as {
      ok: boolean;
      memoryId?: string;
    };
    assert.equal(mcpPayload.ok, true);
    assert.equal(mcpPayload.memoryId, id);

    const status = await server.start();
    const httpRes = await fetch(`http://127.0.0.1:${status.port}/engram/v1/memory/expand`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer operator-token" },
      body: JSON.stringify({ memoryId: handle, sessionKey: SESSION, disclosure: "raw" }),
    });
    assert.equal(httpRes.status, 200);
    const httpBody = (await httpRes.json()) as { ok: boolean; memoryId?: string; rendered?: string };
    assert.equal(httpBody.ok, true);
    assert.equal(httpBody.memoryId, id);
    assert.equal(httpBody.rendered, undefined, "HTTP must not double-count rendered in the returned payload");
  } finally {
    await server.stop();
    await f.cleanup();
  }
});

test("CLI navigate expand uses the shared service and accepts a handle", async () => {
  const f = await surfaceFixture();
  try {
    const storage = f.storages.default!;
    const id = await writeMemory(storage, "CLI handle target.");
    await f.history.record(SESSION, [id]);
    const actions = new Map<string, (...args: unknown[]) => Promise<void>>();
    const cmd: CliCommand = {
      command(name: string) {
        const child: CliCommand = {
          command: cmd.command,
          description() {
            return child;
          },
          option() {
            return child;
          },
          requiredOption() {
            return child;
          },
          argument() {
            return child;
          },
          action(fn) {
            actions.set(name, fn);
            return child;
          },
        };
        return child;
      },
      description() {
        return cmd;
      },
      option() {
        return cmd;
      },
      requiredOption() {
        return cmd;
      },
      argument() {
        return cmd;
      },
      action() {
        return cmd;
      },
    };
    registerRecallNavigationCommands(cmd, f.service["orchestrator"] as Orchestrator);
    const expand = actions.get("navigate expand <memoryId>");
    assert.ok(expand, "CLI must register navigate expand");
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => {
      lines.push(String(value ?? ""));
    };
    try {
      await expand(renderHandle(id), { sessionKey: SESSION, disclosure: "raw", json: true });
    } finally {
      console.log = originalLog;
    }
    const payload = JSON.parse(lines.join("\n")) as { ok: boolean; memoryId?: string };
    assert.equal(payload.ok, true);
    assert.equal(payload.memoryId, id);
  } finally {
    await f.cleanup();
  }
});

test("god files stay under ratchet caps after navigation review fixes", async () => {
  const caps: Record<string, number> = {
    "access-service.ts": 5910,
    "config.ts": 4561,
    "cli.ts": 9428,
    "orchestration/recall-internal.ts": 5344,
  };
  for (const [rel, cap] of Object.entries(caps)) {
    const text = await readFile(path.join(import.meta.dirname, rel), "utf8");
    const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n").length : text.split("\n").length;
    assert.ok(lines <= cap, `${rel} is ${lines} lines; cap is ${cap}`);
  }
});
