/**
 * @remnic/core — Memory Extension Publisher Contract
 *
 * Defines the interface that every host-specific publisher must implement.
 * Each publisher knows how to write Remnic instruction files into the
 * host's extension directory so the host agent can discover and use
 * Remnic memories.
 */

import type { TokenEntry } from "../tokens.js";

/**
 * A publisher that can install (and remove) Remnic memory-extension
 * artefacts into a specific host's extension directory.
 */
export interface MemoryExtensionPublisher {
  /** Unique host identifier (e.g. "codex", "claude-code", "hermes"). */
  readonly hostId: string;

  /**
   * Resolve the absolute path to the extension root for this host.
   * @param env Optional environment to read HOME / host-specific vars from.
   */
  resolveExtensionRoot(env?: NodeJS.ProcessEnv): Promise<string>;

  /** Return true when the host toolchain appears to be installed locally. */
  isHostAvailable(): Promise<boolean>;

  /** Render the full instructions markdown that will be written to disk. */
  renderInstructions(ctx: PublishContext): Promise<string>;

  /** Write extension artefacts to the host's extension directory. */
  publish(ctx: PublishContext): Promise<PublishResult>;

  /** Remove extension artefacts previously written by publish(). */
  unpublish(): Promise<void>;
}

/**
 * Context passed to every publisher method that needs configuration,
 * paths, or logging.
 */
export interface PublishContext {
  readonly config: {
    memoryDir: string;
    daemonUrl?: string;
    daemonPort?: number;
    namespace?: string;
  };
  readonly skillsRoot: string;
  /**
   * Token entry captured before connector installation rotated the token store.
   * Publishers that perform post-install side effects can restore this snapshot
   * if publish fails after the connector install has already committed.
   */
  readonly rollbackTokenEntry?: TokenEntry | null;
  readonly log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

/** Result returned by a successful publish() call. */
export interface PublishResult {
  readonly hostId: string;
  readonly extensionRoot: string;
  readonly filesWritten: string[];
  readonly skipped: string[];
}

/**
 * Declarative capability flags that describe what a given publisher
 * can produce. Useful for feature-gating UI or doctor output without
 * instantiating the publisher.
 */
export interface PublisherCapabilities {
  /** Whether the publisher writes an instructions.md file. */
  readonly instructionsMd: boolean;
  /** Whether the publisher populates a skills folder. */
  readonly skillsFolder: boolean;
  /** Whether the publisher embeds citation format guidance. */
  readonly citationFormat: boolean;
  /** Whether the publisher includes a read-path template for the host. */
  readonly readPathTemplate: boolean;
}
