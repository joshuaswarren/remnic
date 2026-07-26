export {
  InlineExplicitCaptureProcessor,
  hasInlineExplicitCaptureMarkup,
  parseInlineExplicitCaptureNotes,
  persistExplicitCapture,
  queueExplicitCaptureForReview,
  shouldProcessInlineExplicitCapture,
  shouldSkipImplicitExtraction,
  stripInlineExplicitCaptureNotes,
  validateExplicitCaptureInput,
} from "@remnic/core/explicit-capture";

export function mergeInlineCaptureDedupeKeys(
  messageKeys: readonly string[] | null | undefined,
  fallbackDedupeKeys: readonly (string | null)[] = [],
): string[] {
  const dedupeKeys = new Set(messageKeys ?? []);
  if (dedupeKeys.size === 0) {
    for (const key of fallbackDedupeKeys) {
      if (key) dedupeKeys.add(key);
    }
  }
  return [...dedupeKeys];
}

export type {
  ExplicitCaptureInput,
  ExplicitCaptureSource,
  ValidExplicitCapture,
} from "@remnic/core/explicit-capture";
