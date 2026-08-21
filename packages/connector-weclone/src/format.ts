/**
 * Memory format adapter.
 *
 * Converts Remnic recall results into system prompt sections that
 * can be injected into OpenAI-compatible chat completion requests.
 */

export interface RecallResult {
  content: string;
  confidence?: number;
  category?: string;
}

const CHARS_PER_TOKEN = 4;

/**
 * Format recall results into a memory block suitable for prompt injection.
 *
 * - Sorts memories by confidence (highest first; missing confidence sorts last)
 * - Truncates combined content to fit within `maxTokens` (approx 4 chars/token)
 * - Fills in the template's `{memories}` placeholder
 * - Returns empty string if no memories are provided
 */
export function formatMemoryBlock(
  memories: RecallResult[],
  template: string,
  maxTokens: number
): string {
  if (memories.length === 0) {
    return "";
  }

  // Sort by confidence descending; undefined confidence sorts last
  const sorted = [...memories].sort((a, b) => {
    const aConf = a.confidence ?? -1;
    const bConf = b.confidence ?? -1;
    return bConf - aConf;
  });

  const maxChars = maxTokens * CHARS_PER_TOKEN;
  let totalChars = 0;
  const included: string[] = [];

  for (const memory of sorted) {
    const line = memory.content;
    if (totalChars + line.length > maxChars && included.length > 0) {
      break;
    }
    included.push(line);
    totalChars += line.length;
  }

  if (included.length === 0) {
    return "";
  }

  const memoriesText = included.join("\n");
  return template.replace("{memories}", () => memoriesText);
}
