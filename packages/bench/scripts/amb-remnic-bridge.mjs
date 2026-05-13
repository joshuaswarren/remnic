#!/usr/bin/env node
import { createHash } from "node:crypto";
import readline from "node:readline";

const DEFAULT_RECALL_BUDGET_CHARS = 36_000;
const DEFAULT_MAX_DOCUMENT_CONTEXT_CHARS = 12_000;

function parseEnvJson(name) {
  const raw = process.env[name];
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("must be a JSON object");
    }
    return parsed;
  } catch (error) {
    throw new Error(`${name} must be valid JSON: ${error.message}`);
  }
}

function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received ${value}`);
  }
  return parsed;
}

function clipText(value, maxChars) {
  const text = String(value ?? "").trim();
  if (!text || text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 3).trimEnd()}...`;
}

function normalizeSessionPrefix(value) {
  const raw = String(value ?? "amb").trim().toLowerCase();
  const normalized = raw.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "amb";
}

function normalizeRole(role) {
  const lower = String(role ?? "").trim().toLowerCase();
  if (lower === "assistant" || lower === "system") return lower;
  return "user";
}

function parseAmbDocumentMessages(document) {
  const content = String(document.content ?? "");
  const messages = [];
  const context = clipText(
    document.context,
    parsePositiveInteger(
      process.env.REMNIC_AMB_MAX_DOCUMENT_CONTEXT_CHARS,
      DEFAULT_MAX_DOCUMENT_CONTEXT_CHARS,
    ),
  );
  const contextParts = [
    `AMB document id=${document.id ?? "unknown"}`,
    document.user_id ? `user_id=${document.user_id}` : "",
    context ? `context=${context}` : "",
    document.timestamp ? `timestamp=${document.timestamp}` : "",
  ].filter(Boolean);
  if (contextParts.length > 0) {
    messages.push({
      role: "system",
      content: contextParts.join("; "),
    });
  }

  const turnPattern = /(?:^|\n\n)(\[[^\]]+\]\s*)?(User|Assistant|System):\s*/g;
  const matches = [...content.matchAll(turnPattern)];
  if (matches.length === 0) {
    if (content.trim().length > 0) {
      messages.push({ role: "user", content });
    }
    return messages;
  }

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const next = matches[index + 1];
    const bodyStart = match.index + match[0].length;
    const bodyEnd = next ? next.index : content.length;
    const body = content.slice(bodyStart, bodyEnd).trim();
    if (!body) continue;
    const anchor = (match[1] ?? "").trim();
    messages.push({
      role: normalizeRole(match[2]),
      content: anchor ? `${anchor} ${body}` : body,
    });
  }

  return messages;
}

function stableIdForText(prefix, text) {
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  return `${prefix}:${hash}`;
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function loadCreateRemnicAdapter() {
  const module = await import("../dist/index.js");
  if (typeof module.createRemnicAdapter !== "function") {
    throw new Error("Remnic bench adapter build does not export createRemnicAdapter");
  }
  return module.createRemnicAdapter;
}

async function main() {
  const recallBudgetChars = parsePositiveInteger(
    process.env.REMNIC_AMB_RECALL_BUDGET_CHARS,
    DEFAULT_RECALL_BUDGET_CHARS,
  );
  const drainTimeoutMs = parsePositiveInteger(
    process.env.REMNIC_AMB_DRAIN_TIMEOUT_MS,
    180_000,
  );
  const configOverrides = parseEnvJson("REMNIC_AMB_CONFIG_JSON");
  const sessionPrefix = normalizeSessionPrefix(process.env.REMNIC_AMB_SESSION_PREFIX);
  const createRemnicAdapter = await loadCreateRemnicAdapter();
  const adapter = await createRemnicAdapter({
    ...(configOverrides ? { configOverrides } : {}),
    ...(process.env.REMNIC_AMB_MEMORY_DIR
      ? { memoryDir: process.env.REMNIC_AMB_MEMORY_DIR }
      : {}),
    drainTimeoutMs,
    preserveRuntimeDefaults:
      process.env.REMNIC_AMB_PRESERVE_RUNTIME_DEFAULTS !== "0",
    replayExtractionMode:
      process.env.REMNIC_AMB_REPLAY_EXTRACTION_MODE === "background"
        ? "background"
        : "await",
  });

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  const sessionForUser = (userId) => `${sessionPrefix}-${userId || "default"}`;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
      if (request.command === "ingest") {
        const documents = Array.isArray(request.documents)
          ? request.documents
          : [];
        const grouped = new Map();
        for (const document of documents) {
          const userId = document.user_id || "default";
          const existing = grouped.get(userId) ?? [];
          existing.push(...parseAmbDocumentMessages(document));
          grouped.set(userId, existing);
        }
        let storedMessages = 0;
        for (const [userId, messages] of grouped) {
          if (messages.length === 0) continue;
          storedMessages += messages.length;
          await adapter.store(sessionForUser(userId), messages);
        }
        await adapter.drain?.();
        writeJson({
          ok: true,
          documents: documents.length,
          messages: storedMessages,
          session_prefix: sessionPrefix,
          memory_dir: process.env.REMNIC_AMB_MEMORY_DIR ?? null,
        });
      } else if (request.command === "retrieve") {
        const userId = request.user_id || "default";
        const sessionId = sessionForUser(userId);
        const query = String(request.query ?? "");
        const content = await adapter.recall(
          sessionId,
          query,
          recallBudgetChars,
        );
        const trimmed = content.trim();
        writeJson({
          ok: true,
          session_id: sessionId,
          session_prefix: sessionPrefix,
          recall_budget_chars: recallBudgetChars,
          memory_dir: process.env.REMNIC_AMB_MEMORY_DIR ?? null,
          documents: trimmed
            ? [
                {
                  id: stableIdForText(`remnic:${userId}`, trimmed),
                  content: trimmed,
                  user_id: userId,
                },
              ]
            : [],
        });
      } else if (request.command === "reset") {
        await adapter.reset?.();
        writeJson({ ok: true });
      } else if (request.command === "cleanup") {
        await adapter.destroy?.();
        writeJson({ ok: true });
        process.exit(0);
      } else {
        throw new Error(`Unknown command: ${request.command}`);
      }
    } catch (error) {
      writeJson({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await adapter.destroy?.();
}

main().catch((error) => {
  writeJson({
    ok: false,
    fatal: true,
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
