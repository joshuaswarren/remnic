/**
 * `remnic chat` CLI implementation (issue #1583 PR 2).
 *
 * Interactive readline loop that streams assistant text and renders diffs.
 * Supports `--daemon-url` for remote daemon over HTTP (Tailscale fleet case)
 * and `--once` / non-TTY mode for scripting/tests
 * (`echo "question" | remnic chat --once`).
 *
 * Every turn routes through the shared `processChatMessage` factory
 * (issue #2479) so session lifecycle, transcript persistence, and
 * pending-plan/promotion markers behave identically to the HTTP/MCP
 * surfaces.
 *
 * This module is imported by cli.ts with a single thin registration line —
 * the god-file ratchet (#1520) tracks cli.ts LOC.
 */

import { createInterface } from "node:readline";

import type { EngramAccessService } from "../access-service.js";
import type { ChatConfig, ChatTurnResult } from "./chat-types.js";
import { processChatMessage } from "./chat-factory.js";
import {
  createChatSession,
  loadChatSession,
  sessionBelongsToPrincipal,
} from "./chat-session.js";

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

export interface ChatCliOptions {
  service: EngramAccessService;
  config: ChatConfig | undefined;
  memoryDir: string;
  principal?: string;
  namespace?: string;
  sessionKey?: string;
  sessionId?: string;
  once?: boolean;
  input?: string;
}

/**
 * Run the chat CLI.  In interactive mode, enters a readline loop.  In
 * `--once` mode, processes a single message and prints the reply to stdout.
 */
export async function runChatCli(opts: ChatCliOptions): Promise<void> {
  if (!opts.config?.enabled) {
    const msg = "[error] Remnic Chat is disabled. Set \"chat.enabled\": true in your config to enable it.";
    if (opts.once) { process.stdout.write(msg + "\n"); return; }
    console.error(msg);
    return;
  }
  const config = opts.config;
  const llm = opts.service.fallbackLlmRef ?? opts.service.localLlmRef;
  if (!llm) {
    const msg = "[error] No LLM model is available. Configure a local or cloud model to use Remnic Chat.";
    if (opts.once) {
      process.stdout.write(msg + "\n");
      return;
    }
    console.error(msg);
    return;
  }

  // Resolve the session up front so the banner and --once output print a
  // stable session id.  Each turn then routes through processChatMessage,
  let session;
  if (opts.sessionId) {
    session = await loadChatSession(opts.memoryDir, opts.sessionId);
    if (!session) {
      console.error(`Chat session not found: ${opts.sessionId}`);
      return;
    }
    if (!sessionBelongsToPrincipal(session, opts.principal)) {
      console.error("Access denied: this chat session belongs to a different principal.");
      return;
    }
  } else {
    session = await createChatSession(opts.memoryDir, {
      principal: opts.principal,
      sessionKey: opts.sessionKey,
      namespace: opts.namespace,
    });
  }

  const processTurn = (message: string): Promise<ChatTurnResult> =>
    processChatMessage({
      service: opts.service,
      config,
      memoryDir: opts.memoryDir,
      message,
      chatSessionId: session.id,
      principal: opts.principal,
    });

  if (opts.once) {
    const message = opts.input ?? await readAllStdin();
    if (!message.trim()) {
      process.stdout.write("[error] No input provided.\n");
      return;
    }
    const result = await processTurn(message);
    process.stdout.write(result.reply + "\n");
    process.stdout.write(`[session: ${session.id}]\n`);
    return;
  }

  console.log(`Remnic Chat — session ${session.id}`);
  console.log("Type your message. Type 'exit' or Ctrl-C to quit.\n");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "you> ",
  });

  rl.prompt();

  let inFlight: Promise<void> = Promise.resolve();
  rl.on("line", (line: string) => {
    const message = line.trim();
    if (!message) {
      rl.prompt();
      return;
    }
    if (message === "exit" || message === "quit") {
      rl.close();
      return;
    }
    inFlight = inFlight.then(async () => {
    const result = await processTurn(message);

    console.log(`\nassistant> ${result.reply}\n`);
    if (result.pendingPlan) {
      console.log(`[pending plan: ${result.pendingPlan.planId} — reply 'apply' to confirm]\n`);
    }
    if (result.skippedTools && result.skippedTools.length > 0) {
      console.log(`[note: ${result.skippedTools.length} tool(s) skipped due to budget]\n`);
    }
    rl.prompt();
    }).catch(() => {
      console.error("[error] An unexpected error occurred during this turn. Please try again.");
      rl.prompt();
    });
  });

  await new Promise<void>((resolve) => {
    rl.on("close", resolve);
  });
}
