import test from "node:test";
import assert from "node:assert/strict";
import { EngramMcpServer } from "@remnic/core/access-mcp";
import type { EngramAccessService } from "../src/access-service.js";

interface CapturedBriefingCall {
  since?: string;
  focus?: string;
  namespace?: string;
  format?: "markdown" | "json";
  maxFollowups?: number;
}

function createBriefingOnlyService(captured: CapturedBriefingCall[]): EngramAccessService {
  const stub: Partial<EngramAccessService> = {
    briefingEnabled: true,
    briefing: async (request) => {
      captured.push({ ...request });
      return {
        format: request.format ?? "markdown",
        namespace: request.namespace ?? "global",
        window: { from: "2026-04-10T00:00:00.000Z", to: "2026-04-11T00:00:00.000Z" },
        markdown: "# Daily Context Briefing\n\nsynthetic body\n",
        json: {
          generatedAt: "2026-04-11T12:00:00.000Z",
          window: { from: "2026-04-10T00:00:00.000Z", to: "2026-04-11T00:00:00.000Z" },
          sections: {
            activeThreads: [],
            recentEntities: [],
            openCommitments: [],
            suggestedFollowups: [],
          },
        },
        followupsUnavailableReason: undefined,
      };
    },
    // Other methods are not exercised by these tests; leave undefined to keep
    // the stub small. The MCP server's switch only touches `briefing` here.
  };
  return stub as unknown as EngramAccessService;
}

test("remnic_briefing MCP tool appears in tools/list alongside the engram.* alias", async () => {
  const server = new EngramMcpServer(createBriefingOnlyService([]));
  const tools = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });
  const listed = (tools?.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
  assert.ok(
    listed.includes("remnic_briefing"),
    "tools/list should include the canonical remnic_briefing name",
  );
  assert.ok(
    listed.includes("engram.briefing"),
    "tools/list should include the engram.briefing legacy alias",
  );
});

test("remnic.briefing MCP tool dispatches to the service with parsed args", async () => {
  const captured: CapturedBriefingCall[] = [];
  const server = new EngramMcpServer(createBriefingOnlyService(captured));

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "remnic.briefing",
      arguments: {
        since: "3d",
        focus: "project:remnic-core",
        format: "markdown",
        maxFollowups: 4,
      },
    },
  });

  assert.equal(captured.length, 1, "service.briefing should be invoked exactly once");
  assert.equal(captured[0].since, "3d");
  assert.equal(captured[0].focus, "project:remnic-core");
  assert.equal(captured[0].format, "markdown");
  assert.equal(captured[0].maxFollowups, 4);

  const structured = (response?.result as { structuredContent: Record<string, unknown> })
    .structuredContent;
  assert.equal((structured as { format: string }).format, "markdown");
  assert.match((structured as { markdown: string }).markdown, /Daily Context Briefing/);
});

test("engram.briefing legacy alias dispatches to the same service path", async () => {
  const captured: CapturedBriefingCall[] = [];
  const server = new EngramMcpServer(createBriefingOnlyService(captured));

  await server.handleRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "engram.briefing",
      arguments: { format: "json" },
    },
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0].format, "json");
});

// ──────────────────────────────────────────────────────────────────────────
// Regression — Bug 2 (#396): briefing tool must NOT appear when disabled
// ──────────────────────────────────────────────────────────────────────────

test("engram.briefing and remnic.briefing are absent from tools/list when briefing.enabled = false", async () => {
  const disabledService = {
    briefingEnabled: false,
  } as unknown as EngramAccessService;

  const server = new EngramMcpServer(disabledService);
  const tools = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });
  const listed = (tools?.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
  assert.equal(
    listed.includes("engram.briefing"),
    false,
    "engram.briefing must not appear in tools/list when briefing is disabled",
  );
  assert.equal(
    listed.includes("remnic_briefing"),
    false,
    "remnic_briefing must not appear in tools/list when briefing is disabled",
  );
});
