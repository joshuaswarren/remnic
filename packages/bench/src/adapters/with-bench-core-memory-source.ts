import { composeMemoryEnvelope } from "@remnic/core";
import type { Orchestrator } from "@remnic/core";

export async function withBenchCoreMemorySource(
  orchestrator: Orchestrator,
  source: string,
  task: () => Promise<void>,
): Promise<void> {
  type BenchSealedWrite = Orchestrator["storage"]["writeSealedMemory"];
  const storage = orchestrator.storage as unknown as {
    writeSealedMemory: BenchSealedWrite;
  };
  const originalWriteSealedMemory = storage.writeSealedMemory;
  const boundWriteSealedMemory = originalWriteSealedMemory.bind(storage);

  storage.writeSealedMemory = async (envelope, extras) => {
    const requestedSource = envelope.source;
    const sourcedEnvelope = composeMemoryEnvelope(
      {
        content: envelope.content,
        category: envelope.category,
        tags: [...envelope.tags],
        structuredAttributes: envelope.rawStructuredAttributes
          ? { ...envelope.rawStructuredAttributes }
          : undefined,
        entityRef: envelope.entityRef,
        confidence: envelope.confidence,
        ttl: envelope.ttl,
        validAt: envelope.validAt,
        sourceConnector: envelope.sourceConnector,
        sourceReason: envelope.sourceReason,
      },
      {
        source:
          !requestedSource || requestedSource === "extraction"
            ? source
            : requestedSource,
        now: () => new Date(envelope.composedAt),
      },
    );
    return boundWriteSealedMemory(sourcedEnvelope, extras);
  };

  try {
    await task();
  } finally {
    storage.writeSealedMemory = originalWriteSealedMemory;
  }
}
