import { log } from "../logger.js";

export async function drainExtractionAndShutdownDependencyPropagation(
  extractionQueue: { pauseAndDrain(): Promise<boolean> },
  dependencyPropagationDelivery: { shutdown(): Promise<void> } | undefined,
): Promise<unknown | undefined> {
  let extractionDrainError: unknown;
  try {
    if (!await extractionQueue.pauseAndDrain()) {
      extractionDrainError = new Error("orchestrator.destroy: extraction queue did not drain before teardown");
    }
  } catch (error) {
    extractionDrainError = error;
  }
  try {
    await dependencyPropagationDelivery?.shutdown();
  } catch (error) {
    log.warn(`orchestrator.destroy: dependency propagation shutdown failed: ${error}`);
  }
  return extractionDrainError;
}
