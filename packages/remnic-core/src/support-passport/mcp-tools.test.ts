import assert from "node:assert/strict";
import test from "node:test";

import { EngramMcpServer } from "../access-mcp.js";
import type { EngramAccessService } from "../access-service.js";
import { SUPPORT_PASSPORT_MCP_TOOLS } from "./mcp-tools.js";

const REVISION = "a".repeat(64);
const LIST_REQUEST = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

interface ListedTool {
  name: string;
  annotations?: { readOnlyHint?: boolean };
}

function listedTools(response: unknown): ListedTool[] {
  return (response as { result?: { tools?: ListedTool[] } }).result?.tools ?? [];
}

function toolNames(response: unknown): string[] {
  return listedTools(response).map((tool) => tool.name);
}

function call(name: string, args: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

test("support passport MCP tools are hidden until the feature is enabled", async () => {
  const disabled = new EngramMcpServer({ supportPassportEnabled: false } as EngramAccessService);
  const enabled = new EngramMcpServer({ supportPassportEnabled: true } as EngramAccessService);
  const disabledNames = toolNames(await disabled.handleRequest(LIST_REQUEST));
  const enabledTools = listedTools(await enabled.handleRequest(LIST_REQUEST));
  const enabledNames = enabledTools.map((tool) => tool.name);

  assert.equal(
    disabledNames.some((name) => name.includes("support_passport")),
    false
  );
  assert.equal(enabledNames.filter((name) => name.includes("support_passport")).length, 22);
  assert.ok(enabledNames.includes("remnic_support_passport_memory_preview"));
  assert.ok(enabledNames.includes("remnic_support_passport_cards_list"));
  assert.ok(enabledNames.includes("engram.support_passport_grant_revoke"));
  for (const name of ["remnic_support_passport_memory_preview", "engram.support_passport_memory_preview"]) {
    assert.equal(enabledTools.find((tool) => tool.name === name)?.annotations?.readOnlyHint, true);
  }
});

test("manual and replacement MCP tools require an owner review date", () => {
  for (const name of ["engram.support_passport_draft_create", "engram.support_passport_card_replace"]) {
    const tool = SUPPORT_PASSPORT_MCP_TOOLS.find((candidate) => candidate.name === name);
    assert.ok(tool);
    const required = tool.inputSchema.required;
    assert.ok(Array.isArray(required));
    assert.ok(required.includes("reviewBy"));
    if (name === "engram.support_passport_card_replace") {
      assert.equal(Object.prototype.hasOwnProperty.call(tool.inputSchema.properties, "reasonCode"), false);
    }
  }
});

test("MCP tools publish the full opaque source memory ID contract", async () => {
  const memoryId = `care notes/${"x".repeat(501)}`;
  assert.equal(memoryId.length, 512);
  const previewTool = SUPPORT_PASSPORT_MCP_TOOLS.find(
    (candidate) => candidate.name === "engram.support_passport_memory_preview"
  );
  const properties = previewTool?.inputSchema.properties as Record<string, unknown> | undefined;
  const previewSchema = properties?.memoryId as Record<string, unknown> | undefined;
  assert.deepEqual(previewSchema, { type: "string", minLength: 1, maxLength: 512 });

  let receivedMemoryId = "";
  const service = {
    supportPassportEnabled: true,
    supportPassportPreviewMemory: async (_principal: string, received: string) => {
      receivedMemoryId = received;
      return { found: false };
    },
  } as unknown as EngramAccessService;
  const response = await new EngramMcpServer(service, { principal: "owner:alice" }).handleRequest(
    call("remnic.support_passport_memory_preview", { memoryId })
  );
  assert.equal((response as { result?: { isError?: boolean } }).result?.isError, false);
  assert.equal(receivedMemoryId, memoryId);
});

test("MCP drafting requires revisions returned by the owner preview tool", async () => {
  const calls: unknown[] = [];
  const service = {
    supportPassportEnabled: true,
    supportPassportPreviewMemory: async (...args: unknown[]) => {
      calls.push(["preview", ...args]);
      return { memoryId: "memory-one", revision: REVISION, content: "Selected note" };
    },
    supportPassportGenerateDrafts: async (...args: unknown[]) => {
      calls.push(["generate", ...args]);
      return [];
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service, { principal: "owner:alice" });

  const preview = await server.handleRequest(
    call("remnic.support_passport_memory_preview", { memoryId: "memory-one" })
  );
  assert.equal((preview as { result?: { isError?: boolean } }).result?.isError, false);

  const missingRevision = await server.handleRequest(
    call("remnic.support_passport_drafts_generate", {
      sourceMemoryIds: ["memory-one"],
      consent: true,
    })
  );
  assert.equal((missingRevision as { result?: { isError?: boolean } }).result?.isError, true);

  const generated = await server.handleRequest(
    call("remnic.support_passport_drafts_generate", {
      sourceMemoryIds: ["memory-one"],
      sourceMemoryRevisions: [{ memoryId: "memory-one", revision: REVISION }],
      consent: true,
    })
  );
  assert.equal((generated as { result?: { isError?: boolean } }).result?.isError, false);
  assert.deepEqual(calls, [
    ["preview", "owner:alice", "memory-one"],
    [
      "generate",
      "owner:alice",
      {
        sourceMemoryIds: ["memory-one"],
        sourceMemoryRevisions: [{ memoryId: "memory-one", revision: REVISION }],
        consent: true,
        signal: undefined,
      },
    ],
  ]);
});

test("MCP sharing requires the displayed support card revisions", async () => {
  const calls: unknown[] = [];
  const service = {
    supportPassportEnabled: true,
    supportPassportCreateGrant: async (...args: unknown[]) => {
      calls.push(args);
      return { grantId: "grant-one" };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service, { principal: "owner:alice" });
  const expiresAt = "2026-08-11T14:00:00.000Z";

  const missingRevisions = await server.handleRequest(
    call("remnic.support_passport_grant_create", { cardIds: ["card-one"], expiresAt })
  );
  assert.equal((missingRevisions as { result?: { isError?: boolean } }).result?.isError, true);

  const mismatchedRevisions = await server.handleRequest(
    call("remnic.support_passport_grant_create", {
      cardIds: ["card-one"],
      cardRevisions: [{ cardId: "card-two", revision: REVISION }],
      expiresAt,
    })
  );
  assert.equal((mismatchedRevisions as { result?: { isError?: boolean } }).result?.isError, true);

  const valid = await server.handleRequest(
    call("remnic.support_passport_grant_create", {
      cardIds: ["card-one"],
      cardRevisions: [{ cardId: "card-one", revision: REVISION }],
      expiresAt,
    })
  );
  assert.equal((valid as { result?: { isError?: boolean } }).result?.isError, false);
  assert.deepEqual(calls, [
    [
      "owner:alice",
      {
        cardIds: ["card-one"],
        cardRevisions: [{ cardId: "card-one", revision: REVISION }],
        expiresAt,
      },
      {},
    ],
  ]);
});

test("support passport MCP mutations use the trusted principal and strict operation shape", async () => {
  const calls: unknown[] = [];
  const service = {
    supportPassportEnabled: true,
    supportPassportApproveCard: async (...args: unknown[]) => {
      calls.push(args);
      return { cardId: "card-one" };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service, { principal: "owner:alice" });

  const invalid = await server.handleRequest(
    call("remnic.support_passport_card_approve", {
      cardId: "card-one",
      expectedRevision: REVISION,
      reasonCode: "owner-approved",
      actor: "owner:mallory",
    })
  );
  assert.equal((invalid as { result?: { isError?: boolean } }).result?.isError, true);
  assert.equal(calls.length, 0);

  const valid = await server.handleRequest(
    call("remnic.support_passport_card_approve", {
      cardId: "card-one",
      expectedRevision: REVISION,
      reasonCode: "owner-approved",
    })
  );
  assert.equal((valid as { result?: { isError?: boolean } }).result?.isError, false);
  assert.deepEqual(calls, [
    ["owner:alice", "card-one", { expectedRevision: REVISION, reasonCode: "owner-approved" }, {}],
  ]);
});
