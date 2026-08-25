/**
 * Memory-store browse surface tests (issue #2978): ls/tree/find over one
 * resolved namespace, excluded-derived-path invisibility, deterministic
 * ordering, multi-namespace isolation, ACL enforcement, and MCP/HTTP
 * dispatch parity.
 *
 * Service is built the way recall-navigation-surface.test.ts builds it:
 * Object.create(EngramAccessService.prototype) with a stub orchestrator
 * carrying REAL StorageManager instances.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EngramAccessHttpServer } from "./access-http.js";
import { EngramAccessService } from "./access-service.js";
import { EngramMcpServer } from "./access-mcp.js";
import type { CliCommand } from "./cli.js";
import { registerMemoryBrowseCommands } from "./cli/memory-browse-commands.js";
import { parseConfig } from "./config.js";
import { StorageManager } from "./storage.js";
import type { PluginConfig } from "./types.js";
import type { Orchestrator } from "./orchestrator.js";
import { browsePatternMatches, sanitizeBrowsePath } from "./memory-browse.js";

interface BrowseFixture {
  service: EngramAccessService;
  storages: Record<string, StorageManager>;
  config: PluginConfig;
  cleanup: () => Promise<void>;
}

async function browseFixture(options: { namespaces?: boolean } = {}): Promise<BrowseFixture> {
  const base = await mkdtemp(path.join(tmpdir(), "remnic-browse-surface-"));
  const nsRoot = path.join(base, "namespaces");
  if (options.namespaces) {
    await mkdir(path.join(nsRoot, "ns_alice"), { recursive: true });
    await mkdir(path.join(nsRoot, "ns_bob"), { recursive: true });
  }
  const config = parseConfig({
    memoryDir: base,
    qmdCollection: "remnic-browse-test",
    ...(options.namespaces
      ? {
          namespacesEnabled: true,
          defaultNamespace: "default",
          namespacePolicies: [
            { name: "ns_alice", readPrincipals: ["alice"], writePrincipals: ["alice"] },
            { name: "ns_bob", readPrincipals: ["bob"], writePrincipals: ["bob"] },
          ],
        }
      : {}),
  });
  const storages: Record<string, StorageManager> = options.namespaces
    ? {
        ns_alice: await makeStorage(path.join(nsRoot, "ns_alice")),
        ns_bob: await makeStorage(path.join(nsRoot, "ns_bob")),
      }
    : { default: await makeStorage(path.join(base, "default")) };
  const service = Object.create(EngramAccessService.prototype) as EngramAccessService;
  const host = service as unknown as { orchestrator: unknown };
  host.orchestrator = {
    config,
    async getStorage(namespace: string) {
      return storages[namespace] ?? storages.default!;
    },
  };
  return {
    service,
    storages,
    config,
    cleanup: async () => {
      StorageManager.clearAllStaticCaches();
      await rm(base, { recursive: true, force: true });
    },
  };
}

async function makeStorage(dir: string): Promise<StorageManager> {
  const storage = new StorageManager(dir);
  // Await: a fire-and-forget ensureDirectories can recreate dirs while the
  // test's rm cleanup is mid-delete (ENOTEMPTY flake).
  await storage.ensureDirectories();
  return storage;
}

/** MCP text content embeds the JSON payload; pull it out for assertions. */
function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return "{}";
  return text.slice(start, end + 1);
}

function httpServer(service: EngramAccessService): EngramAccessHttpServer {
  return new EngramAccessHttpServer({
    service,
    port: 0,
    trustPrincipalHeader: true,
    adminConsoleEnabled: false,
    authTokenEntriesGetter: () => [{ token: "operator-token", capabilities: { version: 1 } }],
  });
}

test("ls/tree/find over the default namespace: counts, descriptions, nesting", async () => {
  const f = await browseFixture();
  const server = new EngramMcpServer(f.service, { emitLegacyTools: true });
  try {
    const storage = f.storages.default!;
    await storage.writeMemory("fact", "The API rate limit is 1000 requests per minute.");
    await storage.writeMemory("decision", "Ship the browse verbs behind the access boundary.");

    const call = (name: string, arguments_: Record<string, unknown>) =>
      server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: arguments_ } });

    const lsRoot = JSON.parse(
      extractJson(((await call("engram.memory_ls", {})) as { result?: { content?: Array<{ text?: string }> } }).result?.content?.[0]?.text ?? ""),
    ) as { ok: boolean; namespace: string; entries?: Array<{ path: string; kind: string; count: number }>; total: number };
    assert.equal(lsRoot.ok, true);
    assert.deepEqual(
      (lsRoot.entries ?? []).map((entry) => `${entry.kind}:${entry.path}`),
      ["dir:decisions", "dir:facts"],
      "root lists only non-empty recall-category dirs, sorted",
    );
    assert.equal(lsRoot.entries?.[0]?.count, 1);
    assert.equal(lsRoot.entries?.[1]?.count, 1);

    // Facts use the dated layout: facts/<date>/<id>.md, so ls facts lists
    // the date dir and ls the date dir lists the memory files.
    const lsFacts = JSON.parse(
      extractJson(((await call("engram.memory_ls", { path: "facts" })) as { result?: { content?: Array<{ text?: string }> } }).result?.content?.[0]?.text ?? ""),
    ) as { ok: boolean; entries?: Array<{ kind: string; path: string }> };
    assert.equal(lsFacts.ok, true);
    const dateDir = (lsFacts.entries ?? []).find((entry) => entry.kind === "dir");
    assert.ok(dateDir, "facts dir lists its dated subdir");
    assert.match(dateDir!.path, /^facts\/\d{4}-\d{2}-\d{2}$/);

    const lsDate = JSON.parse(
      extractJson(((await call("engram.memory_ls", { path: dateDir!.path })) as { result?: { content?: Array<{ text?: string }> } }).result?.content?.[0]?.text ?? ""),
    ) as { ok: boolean; entries?: Array<{ kind: string; name: string; description: string }> };
    assert.equal(lsDate.ok, true);
    const factFile = (lsDate.entries ?? []).find((entry) => entry.kind === "file");
    assert.ok(factFile, "dated dir lists the written memory file");
    assert.match(factFile!.description, /API rate limit/);

    const tree = JSON.parse(
      extractJson(((await call("engram.memory_tree", { depth: 3 })) as { result?: { content?: Array<{ text?: string }> } }).result?.content?.[0]?.text ?? ""),
    ) as { ok: boolean; entries?: Array<{ path: string; depth: number; kind: string }> };
    assert.equal(tree.ok, true);
    assert.ok((tree.entries ?? []).some((entry) => entry.kind === "dir" && entry.depth === 0 && entry.path === "facts"));
    assert.ok((tree.entries ?? []).some((entry) => entry.kind === "file" && entry.depth === 2 && entry.path.startsWith("facts/")));

    const findByGlob = JSON.parse(
      extractJson(((await call("remnic.memory_find", { pattern: "facts/*/*.md" })) as { result?: { content?: Array<{ text?: string }> } }).result?.content?.[0]?.text ?? ""),
    ) as { ok: boolean; entries?: Array<{ path: string }>; total: number };
    assert.equal(findByGlob.ok, true);
    assert.equal(findByGlob.total, 1);
    assert.match(findByGlob.entries?.[0]?.path ?? "", /^facts\//);

    const findBySubstring = JSON.parse(
      extractJson(((await call("engram.memory_find", { pattern: "rate" })) as { result?: { content?: Array<{ text?: string }> } }).result?.content?.[0]?.text ?? ""),
    ) as { ok: boolean; entries?: Array<{ description: string }>; total: number };
    // Substring matches the PATH/name, not content: "rate" is in the preview
    // but not the filename, so zero hits proves find is deterministic
    // name/path matching, not search.
    assert.equal(findBySubstring.total, 0);
  } finally {
    await f.cleanup();
  }
});

test("derived stores are invisible: artifacts/, meetings records, state/, questions/", async () => {
  const f = await browseFixture();
  const server = new EngramMcpServer(f.service, { emitLegacyTools: true });
  try {
    const storage = f.storages.default!;
    await storage.writeMemory("fact", "Visible recallable fact.");
    // Derived / non-recall stores written straight to disk the way their
    // dedicated writers lay them out.
    const root = storage.dir;
    await mkdir(path.join(root, "artifacts"), { recursive: true });
    await mkdir(path.join(root, "meetings", "2026-08-24"), { recursive: true });
    await mkdir(path.join(root, "state"), { recursive: true });
    await mkdir(path.join(root, "questions"), { recursive: true });
    await writeFile(path.join(root, "artifacts", "secret-artifact.md"), "---\nid: art-1\n---\nhidden artifact body\n");
    await writeFile(path.join(root, "meetings", "2026-08-24", "mtg-2026-08-24-abcdef12.md"), "---\nid: mtg-1\n---\nhidden meeting body\n");
    await writeFile(path.join(root, "state", "lcm.sqlite"), "opaque");
    await writeFile(path.join(root, "questions", "q-1.md"), "---\nid: q-1\n---\nhidden question\n");

    const call = (name: string, arguments_: Record<string, unknown>) =>
      server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: arguments_ } });
    const payload = async (response: unknown): Promise<Record<string, unknown>> =>
      JSON.parse(extractJson(((response as { result?: { content?: Array<{ text?: string }> } }).result?.content?.[0]?.text) ?? "{}")) as Record<string, unknown>;

    const lsRoot = (await payload(await call("engram.memory_ls", {}))) as {
      entries?: Array<{ path: string }>;
    };
    const listed = new Set((lsRoot.entries ?? []).map((entry) => entry.path));
    for (const excluded of ["artifacts", "meetings", "state", "questions"]) {
      assert.ok(!listed.has(excluded), `root ls must not list ${excluded}/`);
    }

    // Direct ls of a derived store is not_found — indistinguishable from a
    // missing path, so existence never leaks.
    const lsArtifacts = (await payload(await call("engram.memory_ls", { path: "artifacts" }))) as { ok: boolean; error?: string };
    assert.equal(lsArtifacts.ok, false);
    assert.equal(lsArtifacts.error, "not_found");

    // find cannot surface derived paths even with a wildcard that matches.
    const findHidden = (await payload(await call("engram.memory_find", { pattern: "*.md" }))) as {
      entries?: Array<{ path: string }>;
    };
    const paths = (findHidden.entries ?? []).map((entry) => entry.path).join("\n");
    assert.ok(!paths.includes("artifacts/"), "find must not return artifact paths");
    assert.ok(!paths.includes("meetings/"), "find must not return meeting-record paths");
    assert.ok(!paths.includes("questions/"), "find must not return question-queue paths");

    const findSecret = (await payload(await call("engram.memory_find", { pattern: "secret-artifact" }))) as { total: number };
    assert.equal(findSecret.total, 0, "artifact name must not be findable");
  } finally {
    await f.cleanup();
  }
});

test("deterministic ordering: code-point sort, stable across duplicate calls", async () => {
  const f = await browseFixture();
  try {
    const storage = f.storages.default!;
    // Names whose locale collation differs from code-point order: uppercase
    // sorts before lowercase in code-point order; "10" before "2".
    await mkdir(path.join(storage.dir, "facts", "2026-08-24"), { recursive: true });
    for (const name of ["zeta.md", "Alpha.md", "alpha.md", "10-x.md", "2-x.md"]) {
      await writeFile(path.join(storage.dir, "facts", "2026-08-24", name), `---\nid: ${name}\n---\nbody of ${name}\n`);
    }
    const browse = (verb: "ls" | "find", request: Record<string, unknown>) =>
      f.service.memoryStoreBrowse({ verb, ...(verb === "find" ? { pattern: "*.md" } : { path: "facts/2026-08-24" }), ...request });

    const first = await browse("ls", {});
    assert.ok(first.ok);
    if (!first.ok) return;
    const names = first.entries.map((entry) => entry.name);
    assert.deepEqual(names, [...names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
    assert.deepEqual(names, ["10-x.md", "2-x.md", "Alpha.md", "alpha.md", "zeta.md"], "code-point order, not locale order");

    const second = await browse("ls", {});
    assert.deepEqual(second.ok ? second.entries.map((entry) => entry.path) : [], first.entries.map((entry) => entry.path), "duplicate call is stable");

    const found = await browse("find", {});
    assert.ok(found.ok);
    if (!found.ok) return;
    assert.deepEqual(
      found.entries.map((entry) => entry.path),
      first.entries.map((entry) => `facts/2026-08-24/${entry.name}`),
      "find returns the same deterministic order",
    );
  } finally {
    await f.cleanup();
  }
});

test("namespace isolation: browse from one namespace never lists another's paths", async () => {
  const f = await browseFixture({ namespaces: true });
  const server = httpServer(f.service);
  try {
    await f.storages.ns_alice!.writeMemory("fact", "Alice-private: the merger closes on Friday.");
    await f.storages.ns_bob!.writeMemory("fact", "Bob-private: the merger closes never.");

    const status = await server.start();
    const post = (body: Record<string, unknown>, principal: string) =>
      fetch(`http://127.0.0.1:${status.port}/engram/v1/memory/ls`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer operator-token", "x-engram-principal": principal },
        body: JSON.stringify(body),
      });

    const alice = await post({ namespace: "ns_alice" }, "alice");
    assert.equal(alice.status, 200);
    const aliceBody = (await alice.json()) as { ok: boolean; entries?: Array<{ path: string }>; rendered?: string };
    assert.equal(aliceBody.ok, true);
    const alicePaths = JSON.stringify(aliceBody.entries ?? []);
    assert.ok(!alicePaths.includes("Bob-private"), "bob content must not appear in alice's ls");
    assert.ok(!alicePaths.includes("ns_bob"), "bob namespace paths must not appear");

    // The wildcard find from alice must not reach bob's namespace either.
    const aliceFind = await fetch(`http://127.0.0.1:${status.port}/engram/v1/memory/find`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer operator-token", "x-engram-principal": "alice" },
      body: JSON.stringify({ namespace: "ns_alice", pattern: "*.md" }),
    });
    const findBody = (await aliceFind.json()) as { ok: boolean; entries?: Array<{ description: string }> };
    assert.equal(findBody.ok, true);
    assert.ok(!JSON.stringify(findBody.entries ?? []).includes("Bob-private"), "find must not cross namespaces");

    // ACL: bob's principal cannot read ns_alice — the read ACL throws.
    const bobProbe = await post({ namespace: "ns_alice" }, "bob");
    assert.equal(bobProbe.status, 400, "namespace not readable by principal is a 400 input error");

    // Unauthenticated caller: namespaces enabled + no principal fails closed.
    const anonProbe = await fetch(`http://127.0.0.1:${status.port}/engram/v1/memory/ls`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer operator-token" },
      body: JSON.stringify({ namespace: "ns_alice" }),
    });
    assert.equal(anonProbe.status, 400, "no principal + namespaces enabled fails closed");
  } finally {
    await server.stop();
    await f.cleanup();
  }
});

test("HTTP parity: /memory/ls, /memory/tree, /memory/find share the service result; input errors are 400", async () => {
  const f = await browseFixture();
  const server = httpServer(f.service);
  try {
    await f.storages.default!.writeMemory("fact", "HTTP parity target memory.");
    const status = await server.start();
    const post = (pathname: string, body: Record<string, unknown>) =>
      fetch(`http://127.0.0.1:${status.port}${pathname}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer operator-token" },
        body: JSON.stringify(body),
      });

    const ls = await post("/engram/v1/memory/ls", {});
    assert.equal(ls.status, 200);
    const lsBody = (await ls.json()) as { ok: boolean; entries?: Array<{ path: string }>; rendered?: string };
    assert.equal(lsBody.ok, true);
    assert.equal(lsBody.rendered, undefined, "HTTP payload strips the rendered field (navigation precedent)");
    assert.ok((lsBody.entries ?? []).some((entry) => entry.path === "facts"));

    const remnicAlias = await post("/remnic/v1/memory/tree", { depth: 3 });
    assert.equal(remnicAlias.status, 200);
    const treeBody = (await remnicAlias.json()) as { ok: boolean; entries?: Array<{ depth: number; kind: string }> };
    assert.equal(treeBody.ok, true);
    assert.ok((treeBody.entries ?? []).some((entry) => entry.kind === "file" && entry.depth === 2), "remnic alias tree reaches files");

    const find = await post("/engram/v1/memory/find", { pattern: "facts/*/*.md" });
    assert.equal(find.status, 200);
    const findBody = (await find.json()) as { ok: boolean; total: number };
    assert.equal(findBody.ok, true);
    assert.ok(findBody.total >= 1, "glob reaches the dated memory file");

    const escaping = await post("/engram/v1/memory/ls", { path: "../../etc" });
    assert.equal(escaping.status, 200);
    const escapingBody = (await escaping.json()) as { ok: boolean; error?: string };
    assert.equal(escapingBody.ok, false);
    assert.equal(escapingBody.error, "invalid_path");

    const badDepth = await post("/engram/v1/memory/tree", { depth: 9 });
    assert.equal(badDepth.status, 200);
    assert.equal(((await badDepth.json()) as { error?: string }).error, "invalid_depth");

    const noPattern = await post("/engram/v1/memory/find", {});
    assert.equal(noPattern.status, 200);
    assert.equal(((await noPattern.json()) as { error?: string }).error, "invalid_pattern");

    const badDepthType = await post("/engram/v1/memory/tree", { depth: "two" });
    assert.equal(badDepthType.status, 400, "non-integer depth is a transport-level 400");
  } finally {
    await server.stop();
    await f.cleanup();
  }
});

test("tools/list: browse tools carry a real outputSchema with declared properties", async () => {
  const f = await browseFixture();
  const server = new EngramMcpServer(f.service, { emitLegacyTools: true });
  try {
    const response = (await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })) as {
      result?: { tools?: Array<{ name: string; outputSchema?: { properties?: Record<string, unknown> }; annotations?: { readOnlyHint?: boolean } }> };
    };
    const tools = response.result?.tools ?? [];
    for (const shortName of ["memory_ls", "memory_tree", "memory_find"]) {
      const engram = tools.find((tool) => tool.name === `engram.${shortName}`);
      const remnic = tools.find((tool) => tool.name === `remnic_${shortName}`);
      assert.ok(engram, `engram.${shortName} listed`);
      assert.ok(remnic, `remnic_${shortName} alias listed`);
      for (const tool of [engram, remnic]) {
        const properties = tool?.outputSchema?.properties ?? {};
        assert.deepEqual(
          Object.keys(properties).sort(),
          ["entries", "error", "message", "namespace", "ok", "path", "rendered", "total", "truncated", "verb"],
          `${tool?.name} outputSchema declares the browse result fields`,
        );
        assert.equal(tool?.annotations?.readOnlyHint, true, `${tool?.name} is annotated read-only`);
      }
    }
  } finally {
    await f.cleanup();
  }
});

test("sanitizeBrowsePath and browsePatternMatches: unit edges", () => {
  assert.equal(sanitizeBrowsePath(undefined), "");
  assert.equal(sanitizeBrowsePath("  "), "");
  assert.equal(sanitizeBrowsePath("/"), "");
  assert.equal(sanitizeBrowsePath("facts/2026-08-24"), "facts/2026-08-24");
  assert.equal(sanitizeBrowsePath(" facts "), "facts");
  for (const bad of ["../facts", "facts/../other", "/facts", "facts//x", "facts\\x", "."]) {
    assert.throws(() => sanitizeBrowsePath(bad), `must reject ${bad}`);
  }
  assert.throws(() => sanitizeBrowsePath("facts/\u0000"), "control characters rejected");

  assert.equal(browsePatternMatches("facts/*.md", "facts/a.md"), true);
  assert.equal(browsePatternMatches("facts/*.md", "facts/sub/a.md"), false, "* does not cross the boundary");
  assert.equal(browsePatternMatches("*.md", "facts/a.md"), true, "glob on basename matches");
  assert.equal(browsePatternMatches("A.MD", "facts/a.md"), true, "case-insensitive");
  assert.equal(browsePatternMatches("a.md", "facts/a.md"), true, "substring on basename");
  assert.equal(browsePatternMatches("zzz", "facts/a.md"), false);
});

/** Stub commander that records registered actions, like the navigation suite. */
function stubCommander(): { cmd: CliCommand; actions: Map<string, (...args: unknown[]) => Promise<void> | void> } {
  const actions = new Map<string, (...args: unknown[]) => Promise<void> | void>();
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
  return { cmd, actions };
}

test("CLI browse ls/tree/find register and share the service implementation", async () => {
  const f = await browseFixture();
  try {
    await f.storages.default!.writeMemory("fact", "CLI browse target memory.");
    const { cmd, actions } = stubCommander();
    registerMemoryBrowseCommands(cmd, (f.service as unknown as { orchestrator: Orchestrator }).orchestrator);
    const ls = actions.get("browse ls [path]");
    const tree = actions.get("browse tree [path]");
    const find = actions.get("browse find <pattern>");
    assert.ok(ls && tree && find, "CLI must register all three browse commands");

    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => {
      lines.push(String(value ?? ""));
    };
    try {
      await ls(undefined, { json: true });
      const lsPayload = JSON.parse(lines.join("\n")) as { ok: boolean; entries?: Array<{ path: string }> };
      assert.equal(lsPayload.ok, true);
      assert.ok((lsPayload.entries ?? []).some((entry) => entry.path === "facts"));

      lines.length = 0;
      await tree("facts", { depth: 2, json: true });
      const treePayload = JSON.parse(lines.join("\n")) as { ok: boolean; entries?: Array<{ kind: string; depth: number }> };
      assert.equal(treePayload.ok, true);
      // Rooted at facts: the dated dir is depth 0 and its files depth 1.
      assert.ok((treePayload.entries ?? []).some((entry) => entry.kind === "file" && entry.depth === 1));

      lines.length = 0;
      await find("facts/*/*.md", { json: true });
      const findPayload = JSON.parse(lines.join("\n")) as { ok: boolean; total: number };
      assert.equal(findPayload.ok, true);
      assert.ok(findPayload.total >= 1);
    } finally {
      console.log = originalLog;
    }
  } finally {
    await f.cleanup();
  }
});
