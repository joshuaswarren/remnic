/**
 * Scoped buffer swap for the out-of-process buffer drain.
 *
 * The drain claims a session's turns into a durable claim file and drives
 * the extraction against THAT buffer: a successfully extracted chunk leaves
 * the claim (so the drain is resumable) instead of the live session file.
 * The live buffer is restored when the task settles.
 */

import { SmartBuffer } from "../buffer.js";
import type { BufferStorage } from "../buffer-persistence.js";
import type { Orchestrator } from "../orchestrator.js";

export async function withBufferStorage<T>(
  orchestrator: Orchestrator,
  storage: BufferStorage,
  task: () => Promise<T>,
): Promise<T> {
  const live = orchestrator.buffer;
  orchestrator.buffer = new SmartBuffer(orchestrator.config, storage);
  try {
    await orchestrator.buffer.load();
    return await task();
  } finally {
    orchestrator.buffer = live;
  }
}
