#!/usr/bin/env node
/**
 * JSONL bridge used by the public Agent Memory Benchmark Python provider.
 *
 * The bridge intentionally keeps AMB as the benchmark authority: AMB owns
 * datasets, answer generation, judging, scoring, and output files. This process
 * only exposes Remnic memory operations through a tiny request/response protocol.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const DEFAULT_RECALL_BUDGET_CHARS = 49_152;
const DEFAULT_DRAIN_TIMEOUT_MS = 8 * 60 * 60 * 1000;

function parsePositiveInteger(value, label, defaultValue) {
  if (value === undefined || value === "") {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer; received ${String(value)}`);
  }
  return parsed;
}

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === "") {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`invalid boolean value: ${String(value)}`);
}

function parseReplayExtractionMode(value) {
  if (value === undefined || value === "") {
    return "await";
  }
  if (value === "await" || value === "background" || value === "skip") {
    return value;
  }
  throw new Error('REMNIC_AMB_REPLAY_EXTRACTION_MODE must be "await", "background", or "skip".');
}

function sanitizeSessionPart(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "unknown";
  return raw.replace(/[^a-zA-Z0-9._:-]+/g, "-").slice(0, 120) || "unknown";
}

export function buildAmbSessionId(document, index) {
  const user = sanitizeSessionPart(document?.user_id ?? "global");
  const id = sanitizeSessionPart(document?.id ?? index);
  return `amb-${user}-${id}-${index}`;
}

export function buildAmbMessages(document) {
  const messages = [];
  const metadata = [];
  if (document?.id) metadata.push(`document_id=${document.id}`);
  if (document?.user_id) metadata.push(`user_id=${document.user_id}`);
  if (document?.timestamp) metadata.push(`timestamp=${document.timestamp}`);
  if (document?.context) metadata.push(`context=${document.context}`);
  if (metadata.length > 0) {
    messages.push({
      role: "system",
      content: `AMB document metadata: ${metadata.join("; ")}`,
    });
  }

  const content = typeof document?.content === "string" ? document.content : "";
  if (content.trim().length > 0) {
    messages.push({
      role: "user",
      content,
    });
  }
  return messages;
}

export function buildAmbRecallDocuments(recalledText, args = {}) {
  const text = typeof recalledText === "string" ? recalledText.trim() : "";
  const k = args.k === undefined ? 10 : Number(args.k);
  if (!Number.isInteger(k) || k <= 0 || text.length === 0) {
    return [];
  }
  return [
    {
      id: `remnic-recall-${randomUUID()}`,
      content: text,
      user_id: args.user_id ?? null,
    },
  ];
}

export async function loadRemnicAmbConfig(env = process.env) {
  const configPath = env.REMNIC_AMB_CONFIG_PATH;
  const configJson = env.REMNIC_AMB_CONFIG_JSON;
  if (configPath && configJson) {
    throw new Error("Set only one of REMNIC_AMB_CONFIG_PATH or REMNIC_AMB_CONFIG_JSON.");
  }

  if (configPath) {
    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`REMNIC_AMB_CONFIG_PATH must point to a JSON object: ${configPath}`);
    }
    return parsed.remnic && typeof parsed.remnic === "object"
      ? { ...parsed.remnic }
      : { ...parsed };
  }

  if (configJson) {
    const parsed = JSON.parse(configJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("REMNIC_AMB_CONFIG_JSON must be a JSON object.");
    }
    return { ...parsed };
  }

  return {};
}

async function loadBenchModule(env = process.env) {
  if (env.REMNIC_AMB_IMPORT === "package") {
    return import("@remnic/bench");
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const sourceIndex = path.resolve(here, "../../packages/bench/src/index.ts");
  if (existsSync(sourceIndex)) {
    try {
      return await import(pathToFileURL(sourceIndex).href);
    } catch (error) {
      if (env.REMNIC_AMB_IMPORT === "source") {
        throw error;
      }
    }
  }

  return import("@remnic/bench");
}

class RemnicAmbBridge {
  constructor(adapter, options) {
    this.adapter = adapter;
    this.options = options;
    this.sessionsByUser = new Map();
    this.allSessions = [];
  }

  async reset() {
    await this.adapter.reset();
    this.sessionsByUser.clear();
    this.allSessions = [];
  }

  async ingest(documents) {
    if (!Array.isArray(documents)) {
      throw new Error("ingest expects a documents array.");
    }
    if (this.options.resetBeforeIngest) {
      await this.reset();
    }

    for (const [index, document] of documents.entries()) {
      const messages = buildAmbMessages(document);
      if (messages.length === 0) {
        continue;
      }
      const sessionId = buildAmbSessionId(document, this.allSessions.length + index);
      await this.adapter.store(sessionId, messages);
      this.allSessions.push(sessionId);
      const userId = document?.user_id ? String(document.user_id) : "";
      if (userId) {
        const sessions = this.sessionsByUser.get(userId) ?? [];
        sessions.push(sessionId);
        this.sessionsByUser.set(userId, sessions);
      }
    }

    if (this.options.drainAfterIngest) {
      await this.adapter.drain?.();
    }
  }

  async retrieve({ query, k, user_id }) {
    const sessionIds =
      user_id && this.sessionsByUser.has(String(user_id))
        ? this.sessionsByUser.get(String(user_id))
        : this.allSessions;
    if (!sessionIds || sessionIds.length === 0) {
      return { documents: [], raw_response: { session_count: 0 } };
    }

    const chunks = [];
    for (const sessionId of sessionIds) {
      const recalled = await this.adapter.recall(
        sessionId,
        String(query ?? ""),
        this.options.recallBudgetChars,
      );
      if (recalled && recalled.trim().length > 0) {
        chunks.push(`## Remnic session ${sessionId}\n${recalled.trim()}`);
      }
    }

    const joined = chunks.join("\n\n");
    return {
      documents: buildAmbRecallDocuments(joined, { k, user_id }),
      raw_response: {
        session_count: sessionIds.length,
        recalled_chars: joined.length,
      },
    };
  }

  async cleanup() {
    await this.adapter.destroy();
  }
}

async function createBridge(env = process.env) {
  const bench = await loadBenchModule(env);
  const configOverrides = await loadRemnicAmbConfig(env);
  const preserveRuntimeDefaults = parseBoolean(
    env.REMNIC_AMB_PRESERVE_RUNTIME_DEFAULTS,
    true,
  );
  const adapter = await bench.createRemnicAdapter({
    configOverrides: {
      lcmEnabled: true,
      ...configOverrides,
    },
    preserveRuntimeDefaults,
    replayExtractionMode: parseReplayExtractionMode(env.REMNIC_AMB_REPLAY_EXTRACTION_MODE),
    drainTimeoutMs: parsePositiveInteger(
      env.REMNIC_AMB_DRAIN_TIMEOUT_MS,
      "REMNIC_AMB_DRAIN_TIMEOUT_MS",
      DEFAULT_DRAIN_TIMEOUT_MS,
    ),
  });

  return new RemnicAmbBridge(adapter, {
    drainAfterIngest: parseBoolean(env.REMNIC_AMB_DRAIN_AFTER_INGEST, true),
    resetBeforeIngest: parseBoolean(env.REMNIC_AMB_RESET_BEFORE_INGEST, false),
    recallBudgetChars: parsePositiveInteger(
      env.REMNIC_AMB_RECALL_BUDGET_CHARS,
      "REMNIC_AMB_RECALL_BUDGET_CHARS",
      DEFAULT_RECALL_BUDGET_CHARS,
    ),
  });
}

async function runJsonlServer() {
  let bridge = await createBridge();
  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: `invalid JSON: ${error.message}` })}\n`);
      continue;
    }

    const id = request.id ?? null;
    try {
      let result;
      switch (request.method) {
        case "reset":
          result = await bridge.reset();
          break;
        case "ingest":
          result = await bridge.ingest(request.params?.documents);
          break;
        case "retrieve":
          result = await bridge.retrieve(request.params ?? {});
          break;
        case "cleanup":
          result = await bridge.cleanup();
          bridge = await createBridge();
          break;
        default:
          throw new Error(`unknown method: ${String(request.method)}`);
      }
      process.stdout.write(`${JSON.stringify({ id, ok: true, result: result ?? null })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })}\n`);
    }
  }

  await bridge.cleanup();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runJsonlServer().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
