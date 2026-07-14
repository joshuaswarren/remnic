#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { parseSyntheticCorrection } from "./mcp-memory-correction.js";

const memories = new Map<string, string[]>();

const server = new McpServer({
  name: "remnic-bench-demo-memory",
  version: "1.0.0",
});

server.registerTool(
  "store_memory",
  {
    description: "Store one synthetic benchmark memory in an isolated session.",
    inputSchema: {
      namespace: z.string(),
      sessionId: z.string(),
      content: z.string(),
      role: z.string().optional(),
      timestamp: z.string().optional(),
    },
  },
  async ({ sessionId, content }) => {
    memories.set(sessionId, [...(memories.get(sessionId) ?? []), content]);
    return { content: [{ type: "text", text: JSON.stringify({ stored: true }) }] };
  }
);

server.registerTool(
  "search_memory",
  {
    description: "Recall memories from one isolated benchmark session.",
    inputSchema: {
      namespace: z.string(),
      sessionId: z.string(),
      query: z.string(),
      limit: z.number().int().positive().optional(),
    },
  },
  async ({ sessionId, limit }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({ memories: (memories.get(sessionId) ?? []).slice(0, limit) }),
      },
    ],
  })
);

server.registerTool(
  "correct_memory",
  {
    description: "Apply a synthetic natural-language correction to one session.",
    inputSchema: {
      namespace: z.string(),
      sessionId: z.string(),
      content: z.string(),
      timestamp: z.string().optional(),
    },
  },
  async ({ sessionId, content }) => {
    const replacement = parseSyntheticCorrection(content);
    const current = memories.get(sessionId) ?? [];
    if (replacement) {
      memories.set(
        sessionId,
        current.map((item) => item.replaceAll(replacement.oldValue, replacement.newValue))
      );
    } else {
      memories.set(sessionId, [...current, content]);
    }
    return { content: [{ type: "text", text: JSON.stringify({ applied: true }) }] };
  }
);

server.registerTool(
  "delete_memory",
  {
    description: "Delete only the requested isolated benchmark session.",
    inputSchema: {
      namespace: z.string(),
      sessionId: z.string(),
    },
  },
  async ({ sessionId }) => {
    memories.delete(sessionId);
    return { content: [{ type: "text", text: JSON.stringify({ deleted: true }) }] };
  }
);

await server.connect(new StdioServerTransport());
