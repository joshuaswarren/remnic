/**
 * Fitness test for the access boundary (issue #1525).
 *
 * Walks the MCP `tools/list` surface and the HTTP route catalog, and asserts:
 *   1. every MCP tool the server actually advertises has a catalog entry
 *      (so a new tool cannot ship without either migrating it or
 *      acknowledging it as unmigrated);
 *   2. every catalog entry that claims a migration (`operation !== null`)
 *      resolves to a registered boundary operation;
 *   3. the unmigrated-handler count equals the ratchet baseline, so the count
 *      may only decrease.
 *
 * Prove-fail-before (issue requirement): a dedicated test seeds a bypass —
 * an MCP tool the catalog does not know about — and asserts the validator
 * reports it. That demonstrates the gate catches the regression class before
 * relying on it for the real surface.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { EngramMcpServer } from "./access-mcp.js";
import type { EngramAccessService } from "./access-service.js";
import { getOperation, listRegisteredOperations, type OperationName } from "./access-boundary.js";
// Importing access-operations registers the three pilot operations as a side
// effect — that is the migration state under test here.
import "./access-operations.js";
import {
  HTTP_ROUTES,
  MCP_TOOLS,
  countUnmigratedHandlers,
  type McpToolEntry,
} from "./access-surface-catalog.js";

// The ratchet baseline. Decrease this constant (and run
// `node scripts/check-ratchets.mjs --update`) whenever a follow-up PR
// migrates a handler. It may NEVER increase — an increase means a new handler
// shipped without going through the boundary. The only exception is a
// catalog-completeness correction: adding routes that were always live but
// omitted from the catalog (review-caught). Such a bump MUST be accompanied
// by the newly-cataloged entries; the higher count is the honest baseline.
const UNMIGRATED_HANDLER_BASELINE = 134;

// Keep the import live — `getOperation` is the call surfaces use at dispatch
// time; referencing it here pins the registry's lookup contract.
void getOperation;

// ---------------------------------------------------------------------------
// Live MCP surface — short-name extraction
// ---------------------------------------------------------------------------

const LEGACY_PREFIX = "engram.";
const CANONICAL_PREFIX = "remnic.";

/** Strip the `engram.`/`remnic.` prefix to get the canonical short name. */
function shortToolName(advertised: string): string {
  if (advertised.startsWith(LEGACY_PREFIX)) return advertised.slice(LEGACY_PREFIX.length);
  if (advertised.startsWith(CANONICAL_PREFIX)) return advertised.slice(CANONICAL_PREFIX.length);
  return advertised;
}

/** Spin up a server with emitLegacyTools=true and read the deduped short names. */
async function liveMcpToolShortNames(): Promise<ReadonlySet<string>> {
  const stub = { briefingEnabled: true } as unknown as EngramAccessService;
  const server = new EngramMcpServer(stub, { emitLegacyTools: true });
  const response = await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const result = (response as { result?: { tools?: Array<{ name: string }> } }).result;
  const names = new Set<string>();
  for (const tool of result?.tools ?? []) {
    names.add(shortToolName(tool.name));
  }
  return names;
}

// ---------------------------------------------------------------------------
// Coverage validator — pure function so the prove-fail-before test can seed a
// bypass against the SAME logic the real assertion uses.
// ---------------------------------------------------------------------------

interface CoverageViolation {
  readonly kind:
    | "live-tool-not-in-catalog"
    | "catalog-tool-not-live"
    | "migrated-entry-not-registered"
    | "duplicate-catalog-tool";
  readonly detail: string;
}

function validateCoverage(
  catalog: readonly McpToolEntry[],
  liveShortNames: ReadonlySet<string>,
  registered: ReadonlySet<OperationName>,
): CoverageViolation[] {
  const violations: CoverageViolation[] = [];
  const catalogShortNames = new Set<string>();

  for (const entry of catalog) {
    if (catalogShortNames.has(entry.tool)) {
      violations.push({ kind: "duplicate-catalog-tool", detail: entry.tool });
    }
    catalogShortNames.add(entry.tool);

    if (!liveShortNames.has(entry.tool)) {
      violations.push({ kind: "catalog-tool-not-live", detail: entry.tool });
    }
    if (entry.operation !== null && !registered.has(entry.operation)) {
      violations.push({
        kind: "migrated-entry-not-registered",
        detail: `${entry.tool} -> ${entry.operation}`,
      });
    }
  }

  for (const live of liveShortNames) {
    if (!catalogShortNames.has(live)) {
      violations.push({ kind: "live-tool-not-in-catalog", detail: live });
    }
  }

  return violations;
}

function shortNamesOf(catalog: readonly McpToolEntry[]): Set<string> {
  const set = new Set<string>();
  for (const entry of catalog) set.add(entry.tool);
  return set;
}

function formatViolations(violations: readonly CoverageViolation[]): string {
  return violations.map((v) => `  - [${v.kind}] ${v.detail}`).join("\n");
}

// ---------------------------------------------------------------------------
// Prove-fail-before: the validator MUST catch a seeded bypass
// ---------------------------------------------------------------------------

test("fitness validator catches an MCP tool the catalog does not know about", () => {
  // Seed: advertise a fake tool that was never added to the catalog. This is
  // exactly the regression the boundary exists to prevent — a new handler
  // shipping with its own ad-hoc validation instead of a registry entry.
  const liveWithBypass = shortNamesOf(MCP_TOOLS);
  liveWithBypass.add("rogue_unregistered_tool");

  const violations = validateCoverage(
    MCP_TOOLS,
    liveWithBypass,
    new Set(listRegisteredOperations()),
  );
  const rogue = violations.filter((v) => v.kind === "live-tool-not-in-catalog");
  assert.ok(rogue.length > 0, "validator must flag a live tool missing from the catalog");
  assert.equal(rogue[0].detail, "rogue_unregistered_tool");
});

test("fitness validator catches a catalog entry claiming a migration the registry does not back", () => {
  // Seed: a catalog entry claims `operation: "memory_get"` but the registry
  // passed in is EMPTY — simulating a handler that flipped its catalog row
  // without adding the `defineOperation` call. Passing an explicit empty set
  // (rather than resetting the real registry) keeps this test isolated from
  // the live pilot registrations.
  const lyingCatalog: readonly McpToolEntry[] = [
    ...MCP_TOOLS,
    { tool: "synthetic_liar", operation: "memory_get" },
  ];
  const live = shortNamesOf(lyingCatalog);
  const emptyRegistry = new Set<OperationName>();

  const violations = validateCoverage(lyingCatalog, live, emptyRegistry);
  const unregistered = violations.filter((v) => v.kind === "migrated-entry-not-registered");
  assert.ok(
    unregistered.some((v) => v.detail.includes("synthetic_liar")),
    "validator must flag a migrated entry with no backing registration",
  );
});

test("fitness validator catches a stale catalog entry (tool removed from the server)", () => {
  // Seed: catalog claims a tool the server no longer advertises.
  const staleCatalog: readonly McpToolEntry[] = [
    ...MCP_TOOLS,
    { tool: "ghost_tool_removed_from_server", operation: null },
  ];
  const live = shortNamesOf(MCP_TOOLS); // server does NOT advertise the ghost

  const violations = validateCoverage(staleCatalog, live, new Set(listRegisteredOperations()));
  const stale = violations.filter((v) => v.kind === "catalog-tool-not-live");
  assert.ok(stale.length > 0, "validator must flag a catalog entry with no live tool");
});

// ---------------------------------------------------------------------------
// Real surface coverage — the gate that runs on every build
// ---------------------------------------------------------------------------

test("MCP tools/list matches the catalog exactly (no untracked handlers)", async () => {
  const live = await liveMcpToolShortNames();
  const violations = validateCoverage(MCP_TOOLS, live, new Set(listRegisteredOperations()));
  assert.deepEqual(
    violations,
    [],
    `surface/catalog drift detected — either update access-surface-catalog.ts or migrate the new handler:\n${formatViolations(violations)}`,
  );
});

// ---------------------------------------------------------------------------
// HTTP source-completeness — static extraction from access-http.ts
// ---------------------------------------------------------------------------

/**
 * The MCP surface has a live coverage test (tools/list). HTTP has no
 * equivalent introspection endpoint — routes are scattered if-branches in
 * EngramAccessHttpServer.handle. This test statically extracts route
 * patterns from the source and compares against HTTP_ROUTES so a new
 * service-invoking route cannot land without a catalog entry.
 *
 * Infrastructure routes (health, adapters, admin console, UI assets, MCP
 * delegate) are excluded — they carry no user-validated request envelope.
 */
test("HTTP handler source routes match the catalog (static completeness)", () => {
  const httpSource = readFileSync(
    new URL("./access-http.ts", import.meta.url),
    "utf-8",
  );
  const lines = httpSource.split("\n");

  // --- Phase 1: pathname-level extraction (catches missing pathnames) -------
  const sourcePaths = new Set<string>();

  for (const m of httpSource.matchAll(
    /pathname\s*===\s*"((?:\/engram|\/remnic|\/v1)\/[^"]+)"/g,
  )) {
    sourcePaths.add(m[1]!.replace(/^\/remnic\//, "/engram/"));
  }
  for (const m of httpSource.matchAll(
    /pathname\.startsWith\("((?:\/engram)\/v1\/[^"]+\/)"/g,
  )) {
    sourcePaths.add(m[1]!.replace(/\/$/, "") + "/:id");
  }
  const normalizeRegexRoute = (src: string): string =>
    src.replace(/\\\//g, "/").replace(/\(\[\^\/\]\+\)/g, ":id");
  for (const m of httpSource.matchAll(/\/\^(.+?)\$\/g?\.(?:exec|test)\(pathname\)/g)) {
    const normalized = normalizeRegexRoute(m[1]!);
    if (normalized.startsWith("/engram/v1/") || normalized.startsWith("/v1/")) {
      sourcePaths.add(normalized);
    }
  }
  for (const m of httpSource.matchAll(/pathname\.match\(\/\^(.+?)\$\/g?\)/g)) {
    const normalized = normalizeRegexRoute(m[1]!);
    if (normalized.startsWith("/engram/v1/") || normalized.startsWith("/v1/")) {
      sourcePaths.add(normalized);
    }
  }

  const INFRA = [
    /^\/engram\/v1\/health$/,
    /^\/engram\/v1\/adapters$/,
    /^\/engram\/v1\/admin\//,
    /^\/engram\/ui/,
    /^\/mcp$/,
  ];
  const servicePaths = [...sourcePaths]
    .filter((p) => !INFRA.some((re) => re.test(p)))
    .sort();

  const catalogPaths = new Set(HTTP_ROUTES.map((r) => r.pathname));
  const missingFromCatalog = servicePaths.filter(
    (p) => !catalogPaths.has(p),
  );
  assert.deepEqual(
    missingFromCatalog,
    [],
    `HTTP routes found in access-http.ts but missing from HTTP_ROUTES catalog.\n` +
      `Add each to access-surface-catalog.ts with operation: null (or migrate it).\n` +
      `Missing:\n${missingFromCatalog.map((p) => `  ${p}`).join("\n")}`,
  );

  // --- Phase 2: (method, pathname) tuple extraction (catches missing methods)
  // For each exact-match route, scan backward up to 5 lines for the HTTP method.
  // For dynamic routes, scan forward up to 40 lines for method checks inside the block.
  const sourceTuples = new Set<string>();
  const isServicePath = (p: string) =>
    !INFRA.some((re) => re.test(p));

  for (let i = 0; i < lines.length; i++) {
    const pathMatch = lines[i]!.match(
      /pathname\s*===\s*"((?:\/engram|\/remnic|\/v1)\/[^"]+)"/,
    );
    if (pathMatch) {
      const pathname = pathMatch[1]!.replace(/^\/remnic\//, "/engram/");
      if (!isServicePath(pathname)) continue;
      // Scan backward for the method declaration.
      for (let j = i; j >= Math.max(0, i - 5); j--) {
        const mMatch = lines[j]!.match(/req\.method\s*===\s*"(\w+)"/);
        if (mMatch) {
          sourceTuples.add(`${mMatch[1]} ${pathname}`);
          break;
        }
      }
    }
  }
  // Dynamic routes: scan forward for method checks.
  for (const m of httpSource.matchAll(
    /(?:\/\^(.+?)\$\/g?\.(?:exec|test)\(pathname\)|pathname\.match\(\/\^(.+?)\$\/g?\)|pathname\.startsWith\("((?:\/engram)\/v1\/[^"]+)"\))/g,
  )) {
    const raw = m[1] ?? m[2] ?? m[3];
    if (!raw) continue;
    let pathname: string;
    if (m[3]) {
      pathname = m[3].replace(/\/$/, "") + "/:id";
    } else {
      pathname = normalizeRegexRoute(raw!);
    }
    if (!pathname.startsWith("/engram/v1/") || !isServicePath(pathname)) continue;
    const matchIndex = httpSource.indexOf(m[0]);
    const matchLine = httpSource.slice(0, matchIndex).split("\n").length;
    // Scan forward for method checks inside the route block.
    for (let j = matchLine; j < Math.min(lines.length, matchLine + 40); j++) {
      // Stop at the next route block.
      if (j > matchLine && /pathname\s*===\s*"|pathname\.startsWith\(|\/\^.*\$\/g?\.(?:exec|test)\(pathname\)|pathname\.match\(/.test(lines[j]!)) {
        break;
      }
      const methodMatch = lines[j]!.match(/req\.method\s*===\s*"(\w+)"/);
      if (methodMatch) {
        sourceTuples.add(`${methodMatch[1]} ${pathname}`);
      }
      // Also handle negated checks: `req.method !== "GET"` → the route IS GET.
      const negMethodMatch = lines[j]!.match(/req\.method\s*!==\s*"(\w+)"/);
      if (negMethodMatch && j === matchLine) {
        sourceTuples.add(`${negMethodMatch[1]} ${pathname}`);
      }
    }
  }

  const catalogTuples = new Set(
    HTTP_ROUTES.map((r) => `${r.method} ${r.pathname}`),
  );
  const missingTuples = [...sourceTuples]
    .filter((t) => !catalogTuples.has(t))
    .sort();
  assert.deepEqual(
    missingTuples,
    [],
    `HTTP (method, pathname) tuples found in access-http.ts but missing from HTTP_ROUTES.\n` +
      `Add each to access-surface-catalog.ts.\n` +
      `Missing:\n${missingTuples.map((t) => `  ${t}`).join("\n")}`,
  );
});

test("every migrated MCP/HTTP entry resolves to a registered boundary operation", () => {
  const registered = new Set(listRegisteredOperations());
  for (const entry of MCP_TOOLS) {
    if (entry.operation !== null) {
      assert.ok(
        registered.has(entry.operation),
        `MCP tool ${entry.tool} claims migration to ${entry.operation} but it is not registered`,
      );
    }
  }
  for (const entry of HTTP_ROUTES) {
    if (entry.operation !== null) {
      assert.ok(
        registered.has(entry.operation),
        `HTTP ${entry.method} ${entry.pathname} claims migration to ${entry.operation} but it is not registered`,
      );
    }
  }
});

test("unmigrated-handler count matches the ratchet baseline (may only decrease)", () => {
  const actual = countUnmigratedHandlers();
  assert.ok(
    actual <= UNMIGRATED_HANDLER_BASELINE,
    `unmigrated handler count grew from ${UNMIGRATED_HANDLER_BASELINE} to ${actual} — every new handler MUST go through the access boundary (issue #1525). Either migrate it or, if it carries no user input, document the exemption in access-surface-catalog.ts and bump the baseline with a justified commit.`,
  );
  // Equality, not just ≤, is the real gate once the baseline is set. We assert
  // it explicitly so a silent catalog edit (e.g. flipping an entry to null
  // during a refactor) is caught even when the count stays under the ceiling.
  assert.equal(
    actual,
    UNMIGRATED_HANDLER_BASELINE,
    `unmigrated handler count changed from ${UNMIGRATED_HANDLER_BASELINE} to ${actual} — update UNMIGRATED_HANDLER_BASELINE here AND run \`node scripts/check-ratchets.mjs --update\` to record the improvement.`,
  );
});


// ---------------------------------------------------------------------------
// Boundary hook forwarding — quota parity (issue #1525 acceptance criterion)
// ---------------------------------------------------------------------------

/**
 * The HTTP memory_store route enforces its write-quota atomically inside the
 * service's idempotent-write lock via an `enforceWriteQuota` callback passed
 * as the service call's second argument. The boundary MUST forward `ctx.hooks`
 * to that second argument — silently dropping it would let writes bypass the
 * quota gate, the exact regression class the #1434 Codex review locked down.
 * These tests prove the pilot operation forwards the hook end-to-end.
 */

test("memory_store operation forwards ctx.hooks to service.memoryStore (quota hook parity)", async () => {
  const captured: { hooks?: unknown } = {};
  const service = {
    memoryStore: async (_request: unknown, hooks?: unknown) => {
      captured.hooks = hooks;
      return {
        schemaVersion: 1,
        operation: "memory_store",
        namespace: "default",
        dryRun: false,
        accepted: true,
        queued: false,
        status: "stored",
      };
    },
  } as unknown as EngramAccessService;

  let quotaCalled = false;
  const op = getOperation("memory_store");
  assert.ok(op, "memory_store must be registered for the pilot");
  await op.run(
    { content: "quota-parity-probe", category: "fact", confidence: 0.9 },
    {
      service,
      hooks: {
        enforceWriteQuota: () => {
          quotaCalled = true;
        },
      },
    },
  );
  // The hooks object MUST reach the service's second argument.
  assert.ok(captured.hooks, "ctx.hooks must be forwarded to service.memoryStore — dropping it silently bypasses the quota gate (#1434)");
  const forwarded = captured.hooks as { enforceWriteQuota?: () => void };
  assert.equal(typeof forwarded?.enforceWriteQuota, "function", "enforceWriteQuota must survive the forwarding");
  // And the forwarded function must be the same callable (the service invokes
  // it as `beforeExecute` inside the idempotent-write lock).
  forwarded?.enforceWriteQuota?.();
  assert.equal(quotaCalled, true, "the forwarded enforceWriteQuota must be invocable");
});

test("memory_store operation forwards undefined hooks when ctx.hooks is absent (CLI parity)", async () => {
  // The CLI store command has no write-quota hook (one-shot process). The
  // boundary must forward `undefined` cleanly so service.memoryStore's
  // optional-hooks parameter stays unset, not an empty object that could
  // mask a future signature change.
  const captured: { hooks?: unknown } = {};
  const service = {
    memoryStore: async (_request: unknown, hooks?: unknown) => {
      captured.hooks = hooks;
      return {
        schemaVersion: 1,
        operation: "memory_store",
        namespace: "default",
        dryRun: false,
        accepted: true,
        queued: false,
        status: "stored",
      };
    },
  } as unknown as EngramAccessService;

  const op = getOperation("memory_store");
  assert.ok(op);
  await op.run(
    { content: "cli-parity-probe", category: "fact", confidence: 0.9 },
    { service },
  );
  assert.equal(captured.hooks, undefined, "absent ctx.hooks must forward as undefined");
});

test("memory_get operation resolves through the boundary without hooks (read parity)", async () => {
  const service = {
    memoryGet: async () => ({ found: false, memoryId: "x", content: "" }),
  } as unknown as EngramAccessService;
  const op = getOperation("memory_get");
  assert.ok(op);
  const output = (await op.run(
    { memoryId: "abc" },
    { service },
  )) as { result: { found: boolean } };
  assert.equal(output.result.found, false);
});