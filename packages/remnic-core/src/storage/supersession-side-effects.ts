import {
  buildRetiredFactTombstoneInputs,
  type TombstoneCreatedBy,
  type TombstoneReason,
} from "../lifecycle/tombstones.js";
import { log } from "../logger.js";
import { stripCitationForTemplate } from "../source-attribution.js";
import { supersessionKeysForFact } from "../temporal-supersession.js";
import type { MemoryFile, MemoryFrontmatter } from "../types.js";
import { composeMemoryEnvelope, type SealedMemoryEnvelope } from "../write-envelope.js";
import { hasSupersessionAudit } from "./supersession-audit.js";

type TombstoneInput = {
  reason: TombstoneReason;
  createdBy: TombstoneCreatedBy;
  sourceMemoryId: string;
  rawContent: string;
  entityRef?: string;
  supersessionKey?: string;
  operationKey?: string;
  createdAt?: string;
  contentHash?: string;
};

export interface SupersessionSideEffectOptions {
  oldMemoryId: string;
  newMemoryId: string;
  reason: string;
  now: string;
  operationId: string;
  exactReplay: boolean;
  currentBefore: MemoryFile;
  updatedFm: MemoryFrontmatter;
  audit?: SupersessionAuditOptions;
  citationTemplate: string;
  correctionsDir: string;
  readMemoryByPath: (filePath: string) => Promise<MemoryFile | null>;
  isColdOrArchiveTierPath: (memoryPath: string) => boolean;
  invalidateColdMemoriesCache: () => void;
  invalidateAllMemoriesCache: () => void;
  bumpMemoryCorpusVersion: () => void;
  appendLifecycleEvent: () => Promise<void>;
  bumpMemoryStatusVersion: () => void;
  hasExactTombstone: (input: TombstoneInput) => Promise<boolean>;
  appendTombstone: (input: TombstoneInput) => Promise<string | null>;
  writeSealedMemory: (
    envelope: SealedMemoryEnvelope,
    extras: { lineage: [string, string]; sourceMemoryId: string }
  ) => Promise<unknown>;
}

export interface SupersessionAuditOptions {
  content: string;
  tags?: string[];
  structuredAttributes?: Record<string, string>;
  source?: string;
}

export async function runSupersessionSideEffects(options: SupersessionSideEffectOptions): Promise<boolean> {
  const {
    oldMemoryId,
    newMemoryId,
    reason,
    now,
    operationId,
    exactReplay,
    currentBefore,
    updatedFm,
    citationTemplate,
  } = options;
  try {
    if (options.isColdOrArchiveTierPath(currentBefore.path)) options.invalidateColdMemoriesCache();
    if (exactReplay) options.invalidateAllMemoriesCache();
    else options.bumpMemoryCorpusVersion();
    await options.appendLifecycleEvent();
    options.bumpMemoryStatusVersion();
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
        }
      )) {
        const exactInput = { ...input, operationKey: operationId };
        const exists = (await options.hasExactTombstone(exactInput)) || (await options.hasExactTombstone(input));
        if (!exists) await options.appendTombstone(exactInput);
      }
    }

    const auditBody = `Superseded: ${options.audit?.content ?? currentBefore.content}\n\nReason: ${reason}`;
    const auditExists = await hasSupersessionAudit(
      {
        correctionsDir: options.correctionsDir,
        readMemoryByPath: options.readMemoryByPath,
      },
      oldMemoryId,
      newMemoryId,
      auditBody,
      options.audit?.structuredAttributes
    );
    if (!auditExists) {
      const auditEnvelope = composeMemoryEnvelope(
        {
          content: auditBody,
          category: "correction",
          confidence: 1,
          tags: options.audit?.tags ?? ["supersession", "auto-resolved"],
          structuredAttributes: options.audit?.structuredAttributes,
        },
        { source: options.audit?.source ?? "contradiction-detection" }
      );
      await options.writeSealedMemory(auditEnvelope, {
        lineage: [oldMemoryId, newMemoryId],
        sourceMemoryId: oldMemoryId,
      });
    }
    options.invalidateAllMemoriesCache();
    return true;
  } catch (err) {
    log.error(`supersession side effects failed for ${oldMemoryId}:`, err);
    return false;
  }
}
