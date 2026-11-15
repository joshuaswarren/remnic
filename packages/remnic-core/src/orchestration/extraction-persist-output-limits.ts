import { resolveRecallEnhancementCapabilities } from "../capabilities.js";
import { blockReceiptCoverage } from "../extraction-receipt-runtime.js";
import type { ExtractionResult, PluginConfig } from "../types.js";

/** Preserve output caps while retaining a conservative receipt coverage signal. */
export function limitedExtractionOutputs(result: ExtractionResult, config: PluginConfig) {
  const rawEntities = Array.isArray(result.entities) ? result.entities : [];
  const rawQuestions = Array.isArray(result.questions) ? result.questions : [];
  const rawProfileUpdates = Array.isArray(result.profileUpdates) ? result.profileUpdates : [];

  const facts = result.facts.slice(0, config.extractionMaxFactsPerRun);
  const entities = rawEntities.slice(0, config.extractionMaxEntitiesPerRun);
  const questions = rawQuestions.slice(0, config.extractionMaxQuestionsPerRun);
  const profileUpdates = rawProfileUpdates.slice(0, config.extractionMaxProfileUpdatesPerRun);
  if ((result.relationships?.length ?? 0) > 5) blockReceiptCoverage();
  if (
    facts.length !== result.facts.length ||
    entities.length !== rawEntities.length ||
    questions.length !== rawQuestions.length ||
    profileUpdates.length !== rawProfileUpdates.length ||
    (result.relationships?.length && !resolveRecallEnhancementCapabilities(config).entityRelationships) ||
    (result.identityReflection && !resolveRecallEnhancementCapabilities(config).identity)
  )
    blockReceiptCoverage();
  return { facts, entities, questions, profileUpdates };
}
