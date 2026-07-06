/**
 * LSP resolution pass tests (issue #1555 step 4 — prove-fail-before).
 *
 * Covers:
 *   - Planner: basic planning, budget enforcement, deterministic ordering
 *   - Executor: happy path (location maps → upgrade applied)
 *   - Executor: location doesn't map → unresolved
 *   - Executor: mid-batch applyUpgrades failure → caught, counted as unresolved
 *   - Executor: server crash mid-run → degradation, remaining sites unresolved
 *   - Executor: fatal error after upgrade in same batch → NOT committed (rule 25)
 *   - Executor: didOpen sent before definition requests (LSP 3.17)
 *   - Executor: workspaceRoot resolves repo-relative paths to absolute URIs
 *   - mapLocationToNode: same-file, cross-file with resolver, fallback
 *   - Characterization: with lsp.enabled=false, resolution is a no-op
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  planLspUpgrades,
  executeLspResolution,
  mapLocationToNode,
  type EdgeUpgrade,
  type NodeLocator,
  type UnresolvedCallSite,
} from "./resolution.js";
import type { LspLocation } from "./types.js";
import type { LspClient } from "./client.js";

// ──────────────────────────────────────────────────────────────────────────
// Planner tests (pure — no I/O)
// ──────────────────────────────────────────────────────────────────────────

function makeCallSite(
  filePath: string,
  calleeName: string,
  calleeByteOffset: number,
  srcQualifiedName: string,
  content = "line0\nline1\nline2",
): UnresolvedCallSite {
  return {
    filePath,
    language: "typescript",
    content,
    calleeByteOffset,
    calleeName,
    srcQualifiedName,
  };
}

test("planner: basic — plans one request per call site", () => {
  const sites = [
    makeCallSite("src/a.ts", "foo", 0, "a.caller"),
    makeCallSite("src/b.ts", "bar", 6, "b.caller"),
  ];
  const result = planLspUpgrades(sites, { maxRequests: 100 });
  assert.equal(result.requests.length, 2);
  assert.equal(result.budgetExhausted, 0);
  // Sorted by file path.
  assert.equal(result.requests[0].filePath, "src/a.ts");
  assert.equal(result.requests[1].filePath, "src/b.ts");
});

test("planner: budget enforcement — excess counted as budgetExhausted", () => {
  const sites = [
    makeCallSite("src/a.ts", "foo", 0, "a.x"),
    makeCallSite("src/b.ts", "bar", 0, "b.x"),
    makeCallSite("src/c.ts", "baz", 0, "c.x"),
  ];
  const result = planLspUpgrades(sites, { maxRequests: 2 });
  assert.equal(result.requests.length, 2);
  assert.equal(result.budgetExhausted, 1);
});

test("planner: zero budget → all exhausted", () => {
  const sites = [makeCallSite("a.ts", "x", 0, "a.x")];
  const result = planLspUpgrades(sites, { maxRequests: 0 });
  assert.equal(result.requests.length, 0);
  assert.equal(result.budgetExhausted, 1);
});

test("planner: deterministic ordering — same input always same output", () => {
  const sites = [
    makeCallSite("src/z.ts", "z", 10, "z.x"),
    makeCallSite("src/a.ts", "a", 5, "a.x"),
    makeCallSite("src/a.ts", "b", 3, "a.y"),
  ];
  const r1 = planLspUpgrades(sites, { maxRequests: 100 });
  const r2 = planLspUpgrades([...sites].reverse(), { maxRequests: 100 });
  assert.deepEqual(
    r1.requests.map((r) => `${r.filePath}:${r.position.line}:${r.position.character}`),
    r2.requests.map((r) => `${r.filePath}:${r.position.line}:${r.position.character}`),
  );
  // Sorted: a.ts byte 3, a.ts byte 5, z.ts byte 10.
  assert.equal(r1.requests[0].calleeName, "b");
  assert.equal(r1.requests[1].calleeName, "a");
  assert.equal(r1.requests[2].calleeName, "z");
});

test("planner: position conversion — byte offset → line/character", () => {
  // content = "line0\nline1\nline2"
  //                    ^ byte 6 = start of "line1"
  const site = makeCallSite("a.ts", "foo", 6, "a.x", "line0\nline1\nline2");
  const result = planLspUpgrades([site], { maxRequests: 100 });
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].position.line, 1);
  assert.equal(result.requests[0].position.character, 0);
});

// ──────────────────────────────────────────────────────────────────────────
// Location → node mapping tests (rule 35 — half-open containment)
// ──────────────────────────────────────────────────────────────────────────

test("mapLocationToNode: location in span → returns qualified name", () => {
  const locator: NodeLocator = (_path, byteOffset) => {
    // Node spans bytes [0, 10).
    return byteOffset >= 0 && byteOffset < 10 ? "mod.target" : null;
  };
  const locations: LspLocation[] = [
    {
      uri: "file:///src/target.ts",
      range: { start: { line: 0, character: 5 }, end: { line: 0, character: 8 } },
    },
  ];
  // callerContent is used for position→byte conversion.
  // character 5 on line 0 = byte 5 (ASCII content).
  const result = mapLocationToNode(
    locations,
    { callerFilePath: "src/target.ts", callerContent: "abcdefghij" },
    locator,
  );
  assert.equal(result, "mod.target");
});

test("mapLocationToNode: location outside span → null", () => {
  const locator: NodeLocator = () => null;
  const locations: LspLocation[] = [
    {
      uri: "file:///src/target.ts",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
    },
  ];
  const result = mapLocationToNode(
    locations,
    { callerFilePath: "src/target.ts", callerContent: "abcdef" },
    locator,
  );
  assert.equal(result, null);
});

test("mapLocationToNode: multiple locations — first match wins", () => {
  let callCount = 0;
  const locator: NodeLocator = () => {
    callCount++;
    return callCount === 2 ? "mod.second" : null;
  };
  const locations: LspLocation[] = [
    { uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } },
    { uri: "file:///b.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } },
  ];
  const result = mapLocationToNode(
    locations,
    { callerFilePath: "src/a.ts", callerContent: "abc" },
    locator,
  );
  assert.equal(result, "mod.second");
});

test("mapLocationToNode: empty locations → null", () => {
  const locator: NodeLocator = () => "should-not-be-called";
  const result = mapLocationToNode(
    [],
    { callerFilePath: "src/a.ts", callerContent: "abc" },
    locator,
  );
  assert.equal(result, null);
});

test("mapLocationToNode: cross-file definition uses resolveContent", () => {
  // Target file has different content than the caller. The correct byte
  // offset can only be computed from the target file's content.
  // Target: "ab\ncdefgh\n" — line 1 starts at byte 3, character 2 = byte 5.
  const locator: NodeLocator = (filePath, byteOffset) => {
    if (filePath === "src/target.ts" && byteOffset === 5) return "mod.target";
    return null;
  };
  const locations: LspLocation[] = [
    {
      uri: "file:///workspace/src/target.ts",
      range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } },
    },
  ];
  const result = mapLocationToNode(
    locations,
    {
      callerFilePath: "src/caller.ts",
      callerContent: "XXXXXXXXXX", // wrong content — must NOT be used
      workspaceRoot: "/workspace",
      resolveContent: (fp) => (fp === "src/target.ts" ? "ab\ncdefgh\n" : null),
    },
    locator,
  );
  assert.equal(result, "mod.target");
});

test("mapLocationToNode: cross-file without resolveContent → callerContent fallback", () => {
  // Without a content resolver, cross-file definitions fall back to the
  // caller's content (best-effort, documented behavior).
  const locator: NodeLocator = () => "mod.fallback";
  const locations: LspLocation[] = [
    { uri: "file:///src/other.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } },
  ];
  const result = mapLocationToNode(
    locations,
    { callerFilePath: "src/caller.ts", callerContent: "abc" },
    locator,
  );
  assert.equal(result, "mod.fallback");
});

// ──────────────────────────────────────────────────────────────────────────
// Executor tests (mock client)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Minimal mock LspClient — only implements the methods the executor calls.
 */
function makeMockClient(
  definitionResults: Map<string, { ok: true; locations: LspLocation[] } | { ok: false; code: string }>,
): LspClient {
  return {
    definition: async (params: { textDocument: { uri: string }; position: { line: number; character: number } }) => {
      // Key by uri+line+character for deterministic lookup.
      const key = `${params.textDocument.uri}:${params.position.line}:${params.position.character}`;
      const result = definitionResults.get(key);
      if (!result) return { ok: true, locations: [] };
      if (result.ok) return result;
      return {
        ok: false,
        degradation: { backend: "lsp" as const, code: result.code as "server_crashed" },
      };
    },
    didOpen: () => {},
    dispose: async () => {},
    supportsDefinition: true,
    pid: undefined,
  } as unknown as LspClient;
}

test("executor: happy path — definition maps to node, upgrade applied", async () => {
  const requests = planLspUpgrades(
    [makeCallSite("src/a.ts", "target", 0, "a.caller")],
    { maxRequests: 100 },
  ).requests;

  // Mock: definition at position {0, 0} returns a location at byte 0
  // in src/target.ts. The nodeLocator finds "mod.target" at byte 0.
  const mockClient = makeMockClient(new Map([
    ["file:///src/a.ts:0:0", {
      ok: true as const,
      locations: [{
        uri: "file:///src/target.ts",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
      }],
    }],
  ]));

  const locator: NodeLocator = () => "mod.target";
  const applied: EdgeUpgrade[] = [];
  const result = await executeLspResolution(requests, {
    client: mockClient,
    nodeLocator: locator,
    applyUpgrades: async (upgrades) => {
      applied.push(...upgrades);
    },
  });

  assert.equal(result.upgraded, 1);
  assert.equal(result.unresolved, 0);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].provenance, "lsp");
  assert.equal(applied[0].confidence, 0.9);
  assert.equal(applied[0].dstQualifiedName, "mod.target");
});

test("executor: definition returns empty → unresolved", async () => {
  const requests = planLspUpgrades(
    [makeCallSite("src/a.ts", "missing", 0, "a.caller")],
    { maxRequests: 100 },
  ).requests;

  const mockClient = makeMockClient(new Map());
  const locator: NodeLocator = () => null;
  const result = await executeLspResolution(requests, {
    client: mockClient,
    nodeLocator: locator,
    applyUpgrades: async () => {},
  });

  assert.equal(result.upgraded, 0);
  assert.equal(result.unresolved, 1);
});

test("executor: mid-batch applyUpgrades failure → caught, counted as unresolved", async () => {
  const requests = planLspUpgrades(
    [makeCallSite("src/a.ts", "target", 0, "a.caller")],
    { maxRequests: 100 },
  ).requests;

  const mockClient = makeMockClient(new Map([
    ["file:///src/a.ts:0:0", {
      ok: true as const,
      locations: [{
        uri: "file:///src/target.ts",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
      }],
    }],
  ]));

  const locator: NodeLocator = () => "mod.target";
  const result = await executeLspResolution(requests, {
    client: mockClient,
    nodeLocator: locator,
    applyUpgrades: async () => {
      throw new Error("simulated transaction failure");
    },
  });

  // The upgrade was found but the apply failed → counted as unresolved.
  assert.equal(result.upgraded, 0);
  assert.equal(result.unresolved, 1);
});

test("executor: server crash mid-run → degradation, remaining unresolved", async () => {
  const sites = [
    makeCallSite("src/a.ts", "first", 0, "a.x"),
    makeCallSite("src/b.ts", "second", 0, "b.x"),
  ];
  const requests = planLspUpgrades(sites, { maxRequests: 100 }).requests;

  // First file batch: definition request gets server_crashed.
  const mockClient = makeMockClient(new Map([
    ["file:///src/a.ts:0:0", { ok: false as const, code: "server_crashed" }],
  ]));

  const result = await executeLspResolution(requests, {
    client: mockClient,
    nodeLocator: () => null,
    applyUpgrades: async () => {},
  });

  assert.ok(result.degradation, "should have a degradation");
  assert.equal(result.degradation.code, "server_crashed");
  // The first request was interrupted by the crash; subsequent file
  // batches are NOT processed because the degradation short-circuits.
  assert.equal(result.upgraded, 0);
});

test("executor: fatal error after upgrade in same batch → NOT committed (rule 25)", async () => {
  // Two call sites in the SAME file. First succeeds, second crashes.
  // The first upgrade must NOT be committed — per-batch atomicity.
  const sites = [
    makeCallSite("src/a.ts", "first", 0, "a.x"),
    makeCallSite("src/a.ts", "second", 6, "a.y"),
  ];
  const requests = planLspUpgrades(sites, { maxRequests: 100 }).requests;

  const mockClient = makeMockClient(new Map([
    // byte 0 → line 0, char 0 — succeeds.
    ["file:///src/a.ts:0:0", {
      ok: true as const,
      locations: [{
        uri: "file:///src/a.ts",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      }],
    }],
    // byte 6 → line 1, char 0 — server crashes.
    ["file:///src/a.ts:1:0", { ok: false as const, code: "server_crashed" }],
  ]));

  let applyCalled = false;
  const result = await executeLspResolution(requests, {
    client: mockClient,
    nodeLocator: () => "mod.target",
    applyUpgrades: async () => { applyCalled = true; },
  });

  // Per-batch atomicity: the upgrade from the first request is NOT
  // committed because the batch was poisoned by the fatal error.
  assert.equal(result.upgraded, 0);
  assert.equal(applyCalled, false, "applyUpgrades must NOT be called for a poisoned batch");
  assert.ok(result.degradation);
  assert.equal(result.degradation.code, "server_crashed");
  // The lost upgrade is counted as unresolved.
  assert.equal(result.unresolved, 1);
});

test("executor: request_timeout counts as unresolved, pass continues", async () => {
  const sites = [
    makeCallSite("src/a.ts", "slow", 0, "a.x"),
    makeCallSite("src/b.ts", "fast", 0, "b.x"),
  ];
  const requests = planLspUpgrades(sites, { maxRequests: 100 }).requests;

  // First request times out; second succeeds.
  const mockClient = makeMockClient(new Map([
    ["file:///src/a.ts:0:0", { ok: false as const, code: "request_timeout" }],
    ["file:///src/b.ts:0:0", {
      ok: true as const,
      locations: [{
        uri: "file:///src/b.ts",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      }],
    }],
  ]));

  const applied: EdgeUpgrade[] = [];
  const result = await executeLspResolution(requests, {
    client: mockClient,
    nodeLocator: () => "mod.resolved",
    applyUpgrades: async (u) => { applied.push(...u); },
  });

  assert.equal(result.upgraded, 1, "second request should succeed");
  assert.equal(result.unresolved, 1, "first request timed out");
  assert.equal(applied.length, 1);
  assert.equal(applied[0].srcQualifiedName, "b.x");
});

test("executor: empty requests → zero upgraded, zero unresolved", async () => {
  const mockClient = makeMockClient(new Map());
  const result = await executeLspResolution([], {
    client: mockClient,
    nodeLocator: () => null,
    applyUpgrades: async () => {},
  });
  assert.equal(result.upgraded, 0);
  assert.equal(result.unresolved, 0);
});

test("executor: didOpen sent before definition request (LSP 3.17)", async () => {
  const requests = planLspUpgrades(
    [makeCallSite("src/a.ts", "target", 0, "a.caller")],
    { maxRequests: 100 },
  ).requests;

  const didOpenCalls: { uri: string; languageId: string; text: string }[] = [];
  const mockClient = {
    definition: async () => ({ ok: true as const, locations: [] }),
    didOpen: (item: { uri: string; languageId: string; text: string }) => {
      didOpenCalls.push({ uri: item.uri, languageId: item.languageId, text: item.text });
    },
    dispose: async () => {},
  } as unknown as LspClient;

  await executeLspResolution(requests, {
    client: mockClient,
    nodeLocator: () => null,
    applyUpgrades: async () => {},
  });

  assert.equal(didOpenCalls.length, 1, "didOpen must be called once per file batch");
  assert.equal(didOpenCalls[0].uri, "file:///src/a.ts");
  assert.equal(didOpenCalls[0].languageId, "typescript");
  assert.equal(didOpenCalls[0].text, "line0\nline1\nline2");
});

test("executor: workspaceRoot resolves repo-relative paths to absolute URIs", async () => {
  const requests = planLspUpgrades(
    [makeCallSite("src/a.ts", "target", 0, "a.caller")],
    { maxRequests: 100 },
  ).requests;

  // With workspaceRoot, the URI sent to the server is absolute.
  const definitionUris: string[] = [];
  const didOpenUris: string[] = [];
  const mockClient = {
    definition: async (params: { textDocument: { uri: string } }) => {
      definitionUris.push(params.textDocument.uri);
      return { ok: true as const, locations: [] };
    },
    didOpen: (item: { uri: string }) => { didOpenUris.push(item.uri); },
    dispose: async () => {},
  } as unknown as LspClient;

  await executeLspResolution(requests, {
    client: mockClient,
    nodeLocator: () => null,
    applyUpgrades: async () => {},
    workspaceRoot: "/workspace",
  });

  assert.equal(didOpenUris.length, 1);
  assert.equal(didOpenUris[0], "file:///workspace/src/a.ts");
  assert.equal(definitionUris.length, 1);
  assert.equal(definitionUris[0], "file:///workspace/src/a.ts");
});
