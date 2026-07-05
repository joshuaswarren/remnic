/**
 * @remnic/core — Claude Code Memory Extension Publisher (stub)
 *
 * Placeholder publisher for Claude Code. Claude Code does not yet
 * support a file-based memory extension directory, so all methods are
 * no-ops that return safe defaults.
 */

import type {
  MemoryExtensionPublisher,
  PublishContext,
  PublishResult,
  PublisherCapabilities,
} from "./types.js";

export class ClaudeCodeMemoryExtensionPublisher implements MemoryExtensionPublisher {
  readonly hostId = "claude-code";

  static readonly capabilities: PublisherCapabilities = {
    isStub: true,
    instructionsMd: false,
    skillsFolder: false,
    citationFormat: false,
    readPathTemplate: false,
  };

  async resolveExtensionRoot(): Promise<string> {
    // Claude Code does not have an extension directory yet.
    return "";
  }

  async isHostAvailable(): Promise<boolean> {
    return false;
  }

  async renderInstructions(_ctx: PublishContext): Promise<string> {
    return "";
  }

  async publish(_ctx: PublishContext): Promise<PublishResult> {
    return {
      hostId: this.hostId,
      extensionRoot: "",
      filesWritten: [],
      skipped: [],
    };
  }

  async unpublish(): Promise<void> {
    // no-op
  }
}
