/**
 * Default on-disk memory sink: `suggest` mode writes review-queue
 * files under `<stateDir>/suggestions/`, `store` mode writes directly
 * under `<stateDir>/records/`. Hosts with a live Remnic daemon pass
 * their own XMemorySink instead.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { expandTildePath } from "@remnic/core";

import type { XMemorySink, XMemorySuggestion } from "./types.js";

export interface FileSinkOptions {
  stateDir: string;
  mode: "suggest" | "store";
}

/** On-disk sink honoring the memoryMode trust gate by directory. */
export function createFileSink(options: FileSinkOptions): XMemorySink {
  const root = path.join(expandTildePath(options.stateDir), options.mode === "store" ? "records" : "suggestions");
  const write = async (suggestion: XMemorySuggestion): Promise<void> => {
    await mkdir(root, { recursive: true });
    const safeName = suggestion.record.postId.replace(/[^0-9A-Za-z._-]/g, "_");
    const target = path.join(root, `${safeName}.json`);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, `${JSON.stringify(suggestion, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, target);
  };
  return {
    submitSuggestion: write,
    storeMemory: write,
  };
}
