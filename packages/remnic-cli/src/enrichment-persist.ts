import { composeSalvagedEnvelope } from "@remnic/core/salvage-envelope";

interface EnrichmentWriter {
  writeSealedMemory(
    envelope: ReturnType<typeof composeSalvagedEnvelope>,
    extras: Record<string, never>,
  ): Promise<unknown>;
}

/**
 * Persist one accepted enrichment candidate through the sealed envelope
 * (issue #1989 PR4). Enrichment-provider output is machine data — salvage;
 * drops are warn-logged by the shared helper.
 */
export async function persistEnrichmentCandidate(
  storage: EnrichmentWriter,
  entityName: string,
  candidate: { text: string; category: Parameters<typeof composeSalvagedEnvelope>[1]["category"]; confidence?: number; tags?: string[]; source: string },
): Promise<void> {
  await storage.writeSealedMemory(
    composeSalvagedEnvelope(
      "enrichment",
      {
        content: candidate.text,
        category: candidate.category,
        confidence: candidate.confidence,
        tags: [...(candidate.tags ?? []), "enrichment", candidate.source],
        entityRef: entityName,
      },
      { source: `enrichment:${candidate.source}` },
    ),
    {},
  );
}
