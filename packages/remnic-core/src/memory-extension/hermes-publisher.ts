/**
 * @remnic/core — Hermes Memory Extension Publisher (stub)
 *
 * Placeholder publisher for Hermes. Hermes uses a daemon-based
 * transport and does not currently consume file-based memory
 * extensions, so all methods are no-ops.
 */

import type {
  MemoryExtensionPublisher,
  PublishContext,
  PublishResult,
  PublisherCapabilities,
} from "./types.js";

export class HermesMemoryExtensionPublisher implements MemoryExtensionPublisher {
  readonly hostId = "hermes";

  static readonly capabilities: PublisherCapabilities = {
    isStub: true,
    instructionsMd: false,
    skillsFolder: false,
    citationFormat: false,
    readPathTemplate: false,
  };

  async resolveExtensionRoot(): Promise<string> {
    // Hermes does not have an extension directory.
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
