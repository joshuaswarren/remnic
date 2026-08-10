import {
  buildRetiredFactTombstoneInputs,
  type TombstoneCreatedBy,
  type TombstoneReason,
} from "../lifecycle/tombstones.js";
import { supersessionKeysForFact } from "../temporal-supersession.js";
import { stripCitationForTemplate } from "../source-attribution.js";
import type { MemoryFile, MemoryFrontmatter } from "../types.js";
import { composeMemoryEnvelope, type SealedMemoryEnvelope } from "../write-envelope.js";
import { log } from "../logger.js";

type TombstoneInput = {
  reason: TombstoneReason;
  createdBy: TombstoneCreatedBy;
  sourceMemoryId: string;
  rawContent: string;
  entityRef?: string;
  supersessionKey?: string;
  createdAt?: string;
  contentHash?: string;
};

export interface SupersessionSideEffectOptions {
  oldMemoryId: string;
  newMemoryId: string;
  reason: string;
  now: string;
  currentBefore: MemoryFile;
  updatedFm: MemoryFrontmatter;
  citationTemplate: string;
  isColdOrArchiveTierPath: (memoryPath: string) => boolean;
  invalidateColdMemoriesCache: () => void;
  bumpMemoryCorpusVersion: () => void;
  appendLifecycleEvent: () => Promise<void>;
  bumpMemoryStatusVersion: () => void;
  appendTombstone: (input: TombstoneInput) => Promise<string | null>;
  writeSealedMemory: (envelope: SealedMemoryEnvelope, extras: { lineage: [string, string] }) => Promise<unknown>;
}

export async function runSupersessionSideEffects(options: SupersessionSideEffectOptions): Promise<void> {
  const {
    oldMemoryId,
    newMemoryId,
    reason,
    now,
    currentBefore,
    updatedFm,
    citationTemplate,
    isColdOrArchiveTierPath,
    invalidateColdMemoriesCache,
    bumpMemoryCorpusVersion,
    appendLifecycleEvent,
    bumpMemoryStatusVersion,
    appendTombstone,
    writeSealedMemory,
  } = options;
  try {
    if (isColdOrArchiveTierPath(currentBefore.path)) invalidateColdMemoriesCache();
    bumpMemoryCorpusVersion();
    await appendLifecycleEvent();
    bumpMemoryStatusVersion();
    log.debug(`superseded memory ${oldMemoryId} by ${newMemoryId}: ${reason}`);

    if (currentBefore.frontmatter.category === "fact") {
      for (const input of buildRetiredFactTombstoneInputs(
        {
          id: oldMemoryId,
          content: stripCitationForTemplate(currentBefore.content, citationTemplate),
          contentHash: currentBefore.frontmatter.contentHash,
          entityRef: updatedFm.entityRef,
          structuredAttributes: currentBefore.frontmatter.structuredAttributes,
        },
        {
          reason: "contradiction_resolution",
          createdBy: "contradiction_resolution",
          createdAt: now,
          supersessionKeysForFact,
        },
      )) {
        await appendTombstone(input);
      }
    }

    const auditEnvelope = composeMemoryEnvelope(
      {
        content: `Superseded: ${currentBefore.content}\n\nReason: ${reason}`,
        category: "correction",
        confidence: 1.0,
        tags: ["supersession", "auto-resolved"],
      },
      { source: "contradiction-detection" },
    );
    await writeSealedMemory(auditEnvelope, { lineage: [oldMemoryId, newMemoryId] });
  } catch (err) {
    log.error(`failed to supersede memory ${oldMemoryId}:`, err);
  }
}
