/**
 * Fitness test for the access boundary (issue #1525).
 *
 * Walks the MCP `tools/list` surface and the HTTP route catalog, and asserts:
 *   1. every MCP tool the server actually advertises has a catalog entry
 *      (so a new tool cannot ship without either migrating it or
 *      acknowledging it as unmigrated);
 *   2. every catalog entry that claims a migration (`operation !== null`)
 *      resolves to a registered boundary operation AND dispatches through it
 *      — a flipped catalog row without wired dispatch is caught, so the
 *      ratchet cannot record a false migration;
 *   3. the unmigrated-handler count equals the ratchet baseline, so the count
 *      may only decrease.
 *
 * Prove-fail-before (issue requirement): dedicated tests seed bypasses — an
 * MCP tool the catalog does not know about, and a catalog entry whose
 * operation is registered but never dispatched — and assert the validators
 * report them. That demonstrates the gates catch the regression class before
 * relying on them for the real surface.
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
  type HttpRouteEntry,
  type McpToolEntry,
} from "./access-surface-catalog.js";
import { SUPPORT_PASSPORT_OWNER_HTTP_ROUTES } from "./support-passport/access-http.js";
import { SUPPORT_PASSPORT_PUBLIC_HTTP_ROUTES } from "./support-passport/public-http.js";

// #1668: all remaining MCP tools migrated through the strict-schema boundary
// (recall, capsule, continuity, work, shared-context, peer, dreams, etc.).
// memory_chat → chat_message; GET /correction/pending → review_queue_list.
const UNMIGRATED_HANDLER_BASELINE = 0;

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
  const stub = { briefingEnabled: true, supportPassportEnabled: true } as unknown as EngramAccessService;
  const server = new EngramMcpServer(stub, { emitLegacyTools: true, codingDecisionVisible: true, architectureCardVisible: true, codegraphVisible: true, sessionDeltaVisible: true, chatVisible: true });
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
// Live dispatch extraction — verify surfaces route through the boundary
// ---------------------------------------------------------------------------

/**
 * Statically extract the MCP dispatch map (`MCP_MIGRATED_OPERATIONS`) from
 * `access-mcp.ts`. This is the map that routes incoming tool calls to the
 * boundary at dispatch time. Comparing it to the catalog proves a flipped
 * catalog row is not a false migration — the surface code must also wire
 * the dispatch.
 */
function extractMcpOperationMap(
  sourceUrl: URL,
  constantName: string,
): Map<string, string> {
  const source = readFileSync(sourceUrl, "utf-8");
  const blockMatch = source.match(
    new RegExp(`(?:export\\s+)?const\\s+${constantName}[^=]*=\\s*\\{([\\s\\S]*?)\\}\\s*(?:as const)?;`),
  );
  assert.ok(blockMatch, `could not find ${constantName} in ${sourceUrl.pathname}`);
  const map = new Map<string, string>();
  for (const m of blockMatch[1]!.matchAll(/"engram\.(\w+)"\s*:\s*"(\w+)"/g)) {
    map.set(m[1]!, m[2]!);
  }
  return map;
}

function extractMcpDispatchMap(): Map<string, string> {
  return new Map([
    ...extractMcpOperationMap(
      new URL("./access-mcp.ts", import.meta.url),
      "MCP_MIGRATED_OPERATIONS",
    ),
    ...extractMcpOperationMap(
      new URL("./support-passport/mcp-tools.ts", import.meta.url),
      "SUPPORT_PASSPORT_MCP_MIGRATED_OPERATIONS",
    ),
  ]);
}

/**
 * Normalize a regex route body (e.g. `\/engram\/v1\/peers\/([^/]+)`) to the
 * catalog pathname form (`/engram/v1/peers/:id`).
 */
function normalizeHttpRegexRoute(src: string): string {
  return src.replace(/\\\//g, "/").replace(/\(\[\^\/\]\+\)/g, ":id");
}

/**
 * Statically extract a route-specific dispatch map from `access-http.ts`:
 * `"${method} ${pathname}"` → set of operations dispatched via
 * `getOperation("…")` or `enforceTokenOp("…")` within that route's handler
 * block. The latter wraps `getOperation(op)` (the same registration
 * assertion) plus token-capability enforcement and is the sanctioned dispatch
 * marker for token-scoped routes (issue #1837). Keying by
 * method+pathname (not just pathname) prevents cross-method contamination
 * when GET and POST share a path — a dispatch in the POST block must not
 * satisfy a GET catalog entry (review P2: key HTTP dispatch coverage by
 * method and path).
 */
function extractHttpRouteDispatchMap(): Map<string, Set<string>> {
  const source = readFileSync(
    new URL("./access-http.ts", import.meta.url),
    "utf-8",
  );
  const lines = source.split("\n");
  const routeOps = new Map<string, Set<string>>();
  let currentKey: string | null = null;
  let lastSeenPathname: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Detect route block start — extract pathname and method.
    let pathname: string | null = null;
    let isExactMatch = false;

    let m = line.match(/pathname\s*===\s*"((?:\/engram|\/remnic|\/v1)\/[^"]+)"/);
    if (m) {
      pathname = m[1]!.replace(/^\/remnic\//, "/engram/");
      isExactMatch = true;
    } else {
      m = line.match(/\/\^((?:\\\/engram|\\\/remnic|\\\/v1).+?)\$\/g?\.(?:exec|test)\(pathname\)/);
      if (m) {
        pathname = normalizeHttpRegexRoute(m[1]!);
      } else {
        m = line.match(/pathname\.match\(\/\^((?:\\\/engram|\\\/remnic|\\\/v1).+?)\$\/g?\)/);
        if (m) {
          pathname = normalizeHttpRegexRoute(m[1]!);
        } else {
          m = line.match(/pathname\.startsWith\("((?:\/engram)\/v1\/[^"]+)"\)/);
          if (m) {
            pathname = m[1]!.replace(/\/$/, "") + "/:id";
          }
        }
      }
    }

    if (pathname) {
      lastSeenPathname = pathname;
      // Determine the HTTP method: same line first, then backward for
      // exact-match routes, forward for dynamic routes. Check both positive
      // (===) and negated (!==) method patterns — `req.method !== "GET"` as
      // a 405 guard means the route IS GET (review P2: require exact method
      // keys; do not fall back to pathname-only when method is undetectable).
      const detectMethod = (text: string): string | null => {
        const pos = text.match(/req\.method\s*===\s*"(\w+)"/);
        if (pos) return pos[1]!;
        const neg = text.match(/req\.method\s*!==\s*"(\w+)"/);
        if (neg) return neg[1]!;
        return null;
      };
      let method = detectMethod(line);
      if (!method && isExactMatch) {
        for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
          method = detectMethod(lines[j]!);
          if (method) break;
        }
      }
      if (!method && !isExactMatch) {
        for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
          if (/pathname\s*===\s*"|\/\^.*\$\/g?\.(?:exec|test)\(pathname\)|pathname\.match\(/.test(lines[j]!)) break;
          method = detectMethod(lines[j]!);
          if (method) break;
        }
      }
      // If the method cannot be determined, the route block is ambiguous and
      // must not be keyed — validateDispatchCoverage will flag any catalog
      // entry claiming migration through it (no pathname-only fallback).
      currentKey = method ? `${method} ${pathname}` : null;
      if (currentKey && !routeOps.has(currentKey)) {
        routeOps.set(currentKey, new Set<string>());
      }
      continue;
    }

    // Detect method changes within a shared route block (e.g. a single
    // regex match with GET/PUT/DELETE branches). When a new method check
    // appears after a route pattern was already detected, update currentKey
    // to the new method + the same pathname so per-method boundary dispatch
    // markers (getOperation/enforceTokenOp) are tracked against the right
    // route key.
    const methodChange = line.match(/req\.method\s*===\s*"(\w+)"/);
    if (methodChange && lastSeenPathname) {
      const newKey = methodChange[1]! + " " + lastSeenPathname;
      if (!routeOps.has(newKey)) {
        routeOps.set(newKey, new Set<string>());
      }
      currentKey = newKey;
    }

    // Collect boundary dispatch markers within the current route block. A
    // plain `getOperation("op")` call OR an `enforceTokenOp("op")` call counts
    // — enforceTokenOp wraps getOperation(op) (the same registration assertion
    // the old marker gave) plus token-capability enforcement, and is the
    // sanctioned dispatch marker for token-scoped routes (issue #1837).
    if (currentKey) {
      const opMatch = line.match(/(?:getOperation|enforceTokenOp)\("(\w+)"\)/);
      if (opMatch) {
        routeOps.get(currentKey)!.add(opMatch[1]!);
      }
    }
  }

  if (/\bawait\s+maybeHandleLifecycleFlush\(/.test(source)) {
    const lifecycleSource = readFileSync(
      new URL("./access-http-lifecycle-flush.ts", import.meta.url),
      "utf-8",
    );
    const lifecycleRoutes = [
      ["/engram/v1/lcm/compaction/flush", "lcm_compaction_flush"],
      ["/engram/v1/extraction/flush", "extraction_force_flush"],
      ["/engram/v1/lcm/compaction/record", "lcm_compaction_record"],
    ] as const;
    for (const [pathname, operation] of lifecycleRoutes) {
      const escapedPathname = pathname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const routeBlock = lifecycleSource.match(
        new RegExp(`pathname\\s*===\\s*"${escapedPathname}"[\\s\\S]*?return true;`),
      )?.[0];
      if (routeBlock?.includes(`deps.enforceTokenOp("${operation}")`)) {
        routeOps.set(`POST ${pathname}`, new Set([operation]));
      }
    }
  }
  for (const [sourcePath, routes] of [
    ["./support-passport/access-http.ts", SUPPORT_PASSPORT_OWNER_HTTP_ROUTES],
    ["./support-passport/public-http.ts", SUPPORT_PASSPORT_PUBLIC_HTTP_ROUTES],
  ] as const) {
    const routeSource = readFileSync(new URL(sourcePath, import.meta.url), "utf-8");
    for (const route of routes) {
      const dynamicCardMutation =
        route.operation.startsWith("support_passport_card_") &&
        routeSource.includes("operation = `support_passport_card_${cardMatch[2]}`");
      const publicDispatch = new RegExp(`runPublicOperation\\(\\s*service,\\s*"${route.operation}"`).test(routeSource);
      if (routeSource.includes(`operation = "${route.operation}"`) || dynamicCardMutation || publicDispatch) {
        routeOps.set(`${route.method} ${route.pathname}`, new Set([route.operation]));
      }
    }
  }
  return routeOps;
}

/**
 * Pure dispatch validator — shared by the prove-fail-before test and the real
 * gate. Flags a catalog entry that claims a migration (`operation !== null`)
 * but whose live surface code does not dispatch through the boundary. A
 * flipped catalog row without wired dispatch is a false migration.
 */
interface DispatchViolation {
  readonly kind:
    | "mcp-no-dispatch"
    | "mcp-dispatch-mismatch"
    | "http-no-dispatch";
  readonly detail: string;
}

function validateDispatchCoverage(
  mcpCatalog: readonly McpToolEntry[],
  httpCatalog: readonly HttpRouteEntry[],
  mcpDispatch: ReadonlyMap<string, string>,
  httpRouteDispatch: ReadonlyMap<string, ReadonlySet<string>>,
): DispatchViolation[] {
  const violations: DispatchViolation[] = [];
  for (const entry of mcpCatalog) {
    if (entry.operation === null) continue;
    const dispatched = mcpDispatch.get(entry.tool);
    if (dispatched === undefined) {
      violations.push({
        kind: "mcp-no-dispatch",
        detail: `${entry.tool} claims migration to ${entry.operation} but has no entry in MCP_MIGRATED_OPERATIONS`,
      });
    } else if (dispatched !== entry.operation) {
      violations.push({
        kind: "mcp-dispatch-mismatch",
        detail: `${entry.tool}: dispatch routes to "${dispatched}" but catalog claims "${entry.operation}"`,
      });
    }
  }
  for (const entry of httpCatalog) {
    if (entry.operation === null) continue;
    // Method+path specific: a boundary dispatch marker (getOperation("…") or
    // enforceTokenOp("…")) must be in THIS method's handler block. No pathname-only fallback —
    // if the extractor could not determine the method, the route block is
    // ambiguous and the catalog entry must not be counted as migrated
    // (review P2: require exact method keys; do not fall back).
    const routeKey = `${entry.method} ${entry.pathname}`;
    const routeOps = httpRouteDispatch.get(routeKey);
    if (!routeOps || !routeOps.has(entry.operation)) {
      violations.push({
        kind: "http-no-dispatch",
        detail: `HTTP ${entry.method} ${entry.pathname} claims migration to ${entry.operation} but no boundary dispatch marker (getOperation("${entry.operation}") or enforceTokenOp("${entry.operation}")) found in its route block in access-http.ts`,
      });
    }
  }
  return violations;
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

test("dispatch validator catches a catalog entry whose operation is registered but never dispatched", () => {
  // Seed: a catalog entry claims `operation: "memory_get"` — the operation IS
  // registered — but the MCP dispatch map passed in is EMPTY, simulating a
  // handler that flipped its catalog row without wiring dispatch through the
  // boundary. Registration alone would pass the old gate; this check must
  // catch the false migration (review P2: verify dispatch before counting).
  const lyingCatalog: readonly McpToolEntry[] = [
    { tool: "synthetic_dispatch_liar", operation: "memory_get" },
  ];
  const violations = validateDispatchCoverage(
    lyingCatalog,
    [],
    new Map<string, string>(),
    new Map<string, ReadonlySet<string>>(),
  );
  const noDispatch = violations.filter((v) => v.kind === "mcp-no-dispatch");
  assert.ok(
    noDispatch.some((v) => v.detail.includes("synthetic_dispatch_liar")),
    "dispatch validator must flag a migrated entry with no surface dispatch wiring",
  );
});

test("dispatch validator catches an HTTP route whose operation is dispatched by a different route", () => {
  // Seed: catalog claims `GET /engram/v1/synthetic` migrated to `memory_get`.
  // The operation IS registered, and `memory_get` IS dispatched — but by a
  // DIFFERENT route (`/engram/v1/memories/:id`). The route-specific check must
  // catch that `/engram/v1/synthetic` itself has no dispatch marker
  // in its handler block. A global set would pass this false migration.
  // (review P2: bind dispatch validation to method/path routes)
  const lyingHttpCatalog: readonly HttpRouteEntry[] = [
    { method: "GET", pathname: "/engram/v1/synthetic", operation: "memory_get" },
  ];
  const routeDispatch = new Map<string, ReadonlySet<string>>([
    ["GET /engram/v1/memories/:id", new Set(["memory_get"])],
  ]);
  const violations = validateDispatchCoverage(
    [],
    lyingHttpCatalog,
    new Map<string, string>(),
    routeDispatch,
  );
  const noDispatch = violations.filter((v) => v.kind === "http-no-dispatch");
  assert.ok(
    noDispatch.some((v) => v.detail.includes("/engram/v1/synthetic")),
    "dispatch validator must flag an HTTP route whose operation is dispatched by a different route",
  );
});

test("dispatch validator catches cross-method contamination on a shared path", () => {
  // Seed: catalog claims `GET /engram/v1/memories` migrated to `memory_store`.
  // The operation IS registered, and `POST /engram/v1/memories` DOES dispatch
  // `memory_store` — but the GET method's own block does not. A pathname-only
  // key would find the POST block's dispatch and pass; the method+pathname key
  // must reject it. (review P2: key HTTP dispatch coverage by method and path)
  const lyingHttpCatalog: readonly HttpRouteEntry[] = [
    { method: "GET", pathname: "/engram/v1/memories", operation: "memory_store" },
  ];
  const routeDispatch = new Map<string, ReadonlySet<string>>([
    ["POST /engram/v1/memories", new Set(["memory_store"])],
  ]);
  const violations = validateDispatchCoverage(
    [],
    lyingHttpCatalog,
    new Map<string, string>(),
    routeDispatch,
  );
  const noDispatch = violations.filter((v) => v.kind === "http-no-dispatch");
  assert.ok(
    noDispatch.some((v) => v.detail.includes("GET /engram/v1/memories")),
    "dispatch validator must flag a GET route whose operation is dispatched only by the POST route on the same path",
  );
});

test("dispatch validator follows lifecycle helper-owned HTTP routes", () => {
  const routeDispatch = extractHttpRouteDispatchMap();
  assert.equal(
    routeDispatch.get("POST /engram/v1/lcm/compaction/flush")?.has("lcm_compaction_flush"),
    true,
  );
  assert.equal(
    routeDispatch.get("POST /engram/v1/extraction/flush")?.has("extraction_force_flush"),
    true,
  );
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
 * Infrastructure routes (health, auth capability probes, admin console, UI
 * assets, MCP delegate) are excluded — they do not invoke an access-service
 * method. (Adapters was migrated into the catalog in issue #1850 round 5.)
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
    /^\/engram\/v1\/live$/,
    /^\/engram\/v1\/capabilities$/,
    /^\/engram\/v1\/authorization$/,
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
    const matchIndex = m.index!;
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
      // Scan within the whole block, not just the match line — some routes
      // (e.g. GET /engram/v1/peers/:id/profile) use the negation as a guard
      // inside the block, not on the regex-match line.
      const negMethodMatch = lines[j]!.match(/req\.method\s*!==\s*"(\w+)"/);
      if (negMethodMatch) {
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

test("every migrated MCP/HTTP entry resolves to a registered AND dispatched boundary operation", () => {
  // Phase 1 — registration: the operation name must exist in the live registry.
  // This catches a flipped catalog row that references an operation no one
  // ever defined.
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

  // Phase 2 — dispatch: the live surface code must route through the boundary.
  // Registration alone is not enough — a flipped catalog row without wired
  // dispatch is a false migration. The ratchet would lower the unmigrated
  // count while the handler still uses its old direct service branch.
  // MCP dispatch is verified against MCP_MIGRATED_OPERATIONS; HTTP dispatch is
  // verified route-specifically (getOperation("…") or enforceTokenOp("…") must
  // be in the entry's own handler block, not just anywhere in the file).
  // (review P2: verify dispatch before counting handlers as migrated;
  //  review P2: bind dispatch validation to method/path routes)
  const mcpDispatch = extractMcpDispatchMap();
  const httpRouteDispatch = extractHttpRouteDispatchMap();
  const violations = validateDispatchCoverage(
    MCP_TOOLS,
    HTTP_ROUTES,
    mcpDispatch,
    httpRouteDispatch,
  );
  assert.deepEqual(
    violations,
    [],
    `catalog entries claim migrations the surface does not dispatch through — ` +
      `a handler is marked migrated but still uses its old direct service branch.\n` +
      violations.map((v) => `  - [${v.kind}] ${v.detail}`).join("\n"),
  );
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
