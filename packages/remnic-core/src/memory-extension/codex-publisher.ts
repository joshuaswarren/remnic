/**
 * @remnic/core — Codex Memory Extension Publisher
 *
 * Writes Remnic instructions into ~/.codex/memories_extensions/remnic/
 * so the Codex agent can discover and use Remnic memories during its
 * consolidation phase.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  MemoryExtensionPublisher,
  PublishContext,
  PublishResult,
  PublisherCapabilities,
} from "./types.js";

import {
  REMNIC_SEMANTIC_OVERVIEW,
  REMNIC_CITATION_FORMAT,
  REMNIC_MCP_TOOL_INVENTORY,
  REMNIC_RECALL_DECISION_RULES,
} from "./shared-instructions.js";
import { readEnvVar, resolveHomeDir } from "../runtime/env.js";

/** Folder name Remnic installs its extension under inside memories_extensions/. */
const REMNIC_EXTENSION_DIR_NAME = "remnic";

function resolveEnvHome(env?: NodeJS.ProcessEnv): string {
  if (env === undefined) return resolveHomeDir();
  return env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
}

function expandTildeWithHome(input: string, homeDir: string): string {
  if (input === "~") return homeDir;
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(homeDir, input.slice(2));
  }
  return input;
}

function normalizeHostRoot(input: string, homeDir: string): string {
  return path.resolve(expandTildeWithHome(input.trim(), homeDir));
}

/**
 * Codex-specific publisher that knows the Codex extension layout:
 *   ~/.codex/memories_extensions/remnic/instructions.md
 */
export class CodexMemoryExtensionPublisher implements MemoryExtensionPublisher {
  readonly hostId = "codex";

  static readonly capabilities: PublisherCapabilities = {
    instructionsMd: true,
    skillsFolder: false,
    citationFormat: true,
    readPathTemplate: true,
  };

  async resolveExtensionRoot(
    env?: NodeJS.ProcessEnv,
  ): Promise<string> {
    const homeDir = resolveEnvHome(env);
    const codexHomeInput = env === undefined
      ? readEnvVar("CODEX_HOME")?.trim()
      : env.CODEX_HOME?.trim();
    const codexHome = codexHomeInput
      ? normalizeHostRoot(codexHomeInput, homeDir)
      : path.resolve(homeDir, ".codex");
    return path.join(codexHome, "memories_extensions", REMNIC_EXTENSION_DIR_NAME);
  }

  async isHostAvailable(): Promise<boolean> {
    try {
      const home = readEnvVar("CODEX_HOME")?.trim() ||
        path.join(resolveHomeDir(), ".codex");
      return fs.existsSync(home);
    } catch {
      return false;
    }
  }

  async renderInstructions(ctx: PublishContext): Promise<string> {
    const memDir = ctx.config.memoryDir;
    const ns = ctx.config.namespace ?? "default";

    const sections: string[] = [
      `# Remnic Memory Extension for Codex\n`,
      `This document tells you how to use Remnic as an authoritative local ` +
        `memory source. Remnic is a local-first, file-backed memory system. ` +
        `All Remnic content lives on disk as plain Markdown.\n`,
      REMNIC_SEMANTIC_OVERVIEW,
      `## Where Remnic Content Lives\n\n` +
        `Memory base directory: \`${memDir}\`\n\n` +
        `Namespace: \`${ns}\`\n\n` +
        `Under the base directory, memories are organized by namespace:\n\n` +
        "```\n" +
        `${memDir}/<namespace>/\n` +
        `  MEMORY.md               # compact top-of-mind memory\n` +
        `  memory_summary.md       # optional longer summary\n` +
        `  skills/\n` +
        `    <skill-name>/SKILL.md # reusable workflows\n` +
        `  rollout_summaries/\n` +
        `    *.md                  # per-session rollup notes\n` +
        "```\n",
      REMNIC_CITATION_FORMAT,
      REMNIC_MCP_TOOL_INVENTORY,
      REMNIC_RECALL_DECISION_RULES,
      `## Sandboxing Rules (Codex Phase-2)\n\n` +
        `When running inside the Codex phase-2 consolidation sandbox:\n\n` +
        `- **No network.** Do not attempt HTTP calls or MCP connections.\n` +
        `- **No CLI invocation.** Do not shell out to \`remnic\` or \`engram\`.\n` +
        `- **No MCP tool calls.** Use filesystem reads only.\n` +
        `- **Local writes** are allowed only where Codex's sandbox policy permits.\n` +
        `- **Respect missing files.** If a file does not exist, move on silently.\n`,
    ];

    return sections.join("\n");
  }

  async publish(ctx: PublishContext): Promise<PublishResult> {
    const extensionRoot = await this.resolveExtensionRoot();
    const instructionsPath = path.join(extensionRoot, "instructions.md");
    const filesWritten: string[] = [];
    const skipped: string[] = [];

    ctx.log.info(`Publishing Codex memory extension to ${extensionRoot}`);

    // Ensure the extension root exists.
    fs.mkdirSync(extensionRoot, { recursive: true });

    // Render and write instructions.md using atomic write (temp + rename).
    // Per CLAUDE.md #54: never delete before write in file replace operations.
    const content = await this.renderInstructions(ctx);
    const tmpPath = `${instructionsPath}.tmp-${process.pid}-${Date.now()}`;

    try {
      fs.writeFileSync(tmpPath, content, "utf-8");
      fs.renameSync(tmpPath, instructionsPath);
      filesWritten.push(instructionsPath);
      ctx.log.info(`Wrote ${instructionsPath}`);
    } catch (err) {
      // Clean up temp file on failure.
      try {
        if (fs.existsSync(tmpPath)) {
          fs.unlinkSync(tmpPath);
        }
      } catch {
        // swallow cleanup error
      }
      throw err;
    }

    return {
      hostId: this.hostId,
      extensionRoot,
      filesWritten,
      skipped,
    };
  }

  async unpublish(): Promise<void> {
    const extensionRoot = await this.resolveExtensionRoot();
    if (fs.existsSync(extensionRoot)) {
      fs.rmSync(extensionRoot, { recursive: true, force: true });
    }
  }
}
