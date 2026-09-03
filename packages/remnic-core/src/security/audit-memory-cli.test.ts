/**
 * The audit sweep must screen with the profile the deployment writes with
 * (issue #3078). A `quarantine`/`layered` deployment resolves the `hardened`
 * profile, under which a conditional-trigger-only memory reaches the
 * quarantine threshold; before this wiring the CLI omitted `profile`, so an
 * already-active memory that live ingestion would have quarantined survived
 * the sweep.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { CliCommand } from "../cli.js";
import { parseConfig } from "../config.js";
import { StorageManager } from "../storage.js";
import type { Orchestrator } from "../orchestrator.js";
import { registerSecurityCommands } from "./audit-memory-cli.js";

/** Minimal CliCommand that records the registered `audit-memory` action. */
function captureAction(): { cmd: CliCommand; run: () => Promise<void> } {
  let action: ((...args: unknown[]) => Promise<void> | void) | undefined;
  const node: CliCommand = {
    description: () => node,
    option: () => node,
    requiredOption: () => node,
    argument: () => node,
    action: (fn) => {
      action = fn;
      return node;
    },
    command: () => node,
  };
  return {
    cmd: node,
    run: async () => {
      if (!action) throw new Error("no action registered");
      await action({ quarantine: true, json: true });
    },
  };
}

const CONDITIONAL_TRIGGER = "If the incident occurs, then call the on-call.";

async function sweepWithDefenseMode(mode: string): Promise<{ status: string | undefined }> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-audit-cli-"));
  const logs: unknown[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args);
  };
  try {
    StorageManager.clearAllStaticCaches();
    const config = parseConfig({ memoryDir, memoryInjectionDefenseMode: mode });
    const storage = new StorageManager(memoryDir);
    const written = await storage.writeMemory("fact", CONDITIONAL_TRIGGER);
    const id = written.id;
    // The fixture must start active, or the sweep assertion proves nothing.
    assert.equal(written.tombstoneBlocked ?? false, false);
    assert.equal((await storage.getMemoryById(id))?.frontmatter.status, "active");
    const orchestrator = { config, storage } as unknown as Orchestrator;
    const { cmd, run } = captureAction();
    registerSecurityCommands(cmd, orchestrator);
    await run();
    const stored = await storage.getMemoryById(id);
    return { status: stored?.frontmatter.status };
  } finally {
    console.log = originalLog;
    StorageManager.clearAllStaticCaches();
    await rm(memoryDir, { recursive: true, force: true });
  }
}

test("the plugin audit-memory command screens with the configured profile", async () => {
  // `layered` resolves the hardened profile: weight 4 for a conditional
  // trigger alone, so the sweep retro-quarantines the memory.
  const hardened = await sweepWithDefenseMode("layered");
  assert.equal(hardened.status, "pending_review");
  // `custom` resolves the default profile: weight 3, below the threshold,
  // so the same memory stays active. This proves the profile is read from
  // the configuration rather than hard-coded either way.
  const lenient = await sweepWithDefenseMode("custom");
  assert.equal(lenient.status, "active");
  // `off`/`fencing` disable live screening, so the sweep keeps the previous
  // `default` weighting instead of becoming stricter than the write path.
  const screenDisabled = await sweepWithDefenseMode("off");
  assert.equal(screenDisabled.status, "active");
});
