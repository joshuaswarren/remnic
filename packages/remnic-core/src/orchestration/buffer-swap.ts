
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
