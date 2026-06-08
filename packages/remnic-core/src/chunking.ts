/**
 * Automatic Chunking with Overlap (Phase 2A)
 *
 * Sentence-boundary chunking for long memories.
 * Preserves coherent thoughts by never splitting mid-sentence.
 */

export interface ChunkingConfig {
  /** Target tokens per chunk (default 200) */
  targetTokens: number;
  /** Minimum tokens to trigger chunking (default 150) */
  minTokens: number;
  /** Number of sentences to overlap between chunks (default 2) */
  overlapSentences: number;
}

export interface Chunk {
  /** Chunk content */
  content: string;
  /** 0-based index */
  index: number;
  /** Approximate token count */
  tokenCount: number;
}

export interface ChunkResult {
  /** Whether content was chunked */
  chunked: boolean;
  /** Array of chunks (length 1 if not chunked) */
  chunks: Chunk[];
}

/** Default chunking configuration */
export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  targetTokens: 200,
  minTokens: 150,
  overlapSentences: 2,
};

/**
 * Estimate token count for text.
 * Rough approximation: ~4 characters per token for English.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Split text into sentences.
 * Handles common abbreviations and edge cases.
 */
function splitSentences(text: string): string[] {
  // Split on sentence-ending punctuation followed by whitespace or end of string
  // Preserve the punctuation with the sentence
  const sentences: string[] = [];

  // Regex to match sentence boundaries
  // Match: period/exclamation/question followed by space or end, but not abbreviations
  // Lookahead (?=\s|$) instead of consuming (?:\s+|$) avoids a \s+/[^.!?]* overlap,
  // and the bounded {0,100000}/{1,100000} repetitions keep the whole pattern from
  // backtracking polynomially on long unterminated input (CodeQL js/polynomial-redos).
  // 100 000 chars far exceeds any real sentence run, so this is behavior-preserving;
  // each sentence is trimmed, so trailing whitespace is dropped either way.
  const sentenceRegex = /[^.!?]{0,100000}[.!?]{1,100000}(?=\s|$)/g;

  let match: RegExpExecArray | null;
  let lastIndex = 0;

  while ((match = sentenceRegex.exec(text)) !== null) {
    sentences.push(match[0].trim());
    lastIndex = sentenceRegex.lastIndex;
  }

  // Handle remaining text without sentence-ending punctuation
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex).trim();
    if (remaining) {
      sentences.push(remaining);
    }
  }

  // Filter out empty sentences
  return sentences.filter((s) => s.length > 0);
}

/**
 * Chunk content into overlapping segments at sentence boundaries.
 *
 * @param content - The text content to chunk
 * @param config - Chunking configuration
 * @returns ChunkResult with chunks array
 */
export function chunkContent(
  content: string,
  config: ChunkingConfig = DEFAULT_CHUNKING_CONFIG,
): ChunkResult {
  const totalTokens = estimateTokens(content);

  // Don't chunk if below minimum threshold
  if (totalTokens < config.minTokens) {
    return {
      chunked: false,
      chunks: [{
        content,
        index: 0,
        tokenCount: totalTokens,
      }],
    };
  }

  const sentences = splitSentences(content);

  // If we couldn't split into multiple sentences, don't chunk
  if (sentences.length <= 1) {
    return {
      chunked: false,
      chunks: [{
        content,
        index: 0,
        tokenCount: totalTokens,
      }],
    };
  }

  const chunks: Chunk[] = [];
  let currentChunkSentences: string[] = [];
  let currentTokens = 0;
  let chunkIndex = 0;

  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i];
    const sentenceTokens = estimateTokens(sentence);

    // Add sentence to current chunk
    currentChunkSentences.push(sentence);
    currentTokens += sentenceTokens;

    // Check if we've reached target size (with some flexibility)
    // Allow going over by up to 50% to avoid tiny final chunks
    const atTarget = currentTokens >= config.targetTokens;
    const isLastSentence = i === sentences.length - 1;

    if (atTarget || isLastSentence) {
      // Create chunk from accumulated sentences
      const chunkContent = currentChunkSentences.join(" ");
      chunks.push({
        content: chunkContent,
        index: chunkIndex,
        tokenCount: estimateTokens(chunkContent),
      });
      chunkIndex++;

      // Start new chunk with overlap (if not at end)
      if (!isLastSentence) {
        // Keep last N sentences for overlap.
        // Guard: slice(-0) === slice(0), which returns the ENTIRE array
        // (CLAUDE.md gotcha #27). When overlapSentences is 0, clear fully.
        const overlapCount = Math.min(config.overlapSentences, currentChunkSentences.length);
        if (overlapCount <= 0) {
          currentChunkSentences = [];
          currentTokens = 0;
        } else {
          currentChunkSentences = currentChunkSentences.slice(-overlapCount);
          currentTokens = currentChunkSentences.reduce((sum, s) => sum + estimateTokens(s), 0);
        }
      }
    }
  }

  // Only consider it "chunked" if we got multiple chunks
  return {
    chunked: chunks.length > 1,
    chunks,
  };
}

/**
 * Get parent content by reassembling chunks.
 * Useful for displaying full context when a chunk is retrieved.
 *
 * @param chunks - Array of chunk contents in order
 * @returns Reassembled parent content (with overlap removed)
 */
export function reassembleChunks(chunks: string[]): string {
  if (chunks.length === 0) return "";
  if (chunks.length === 1) return chunks[0];

  // For overlapping chunks, we need to deduplicate
  // Simple approach: use full first chunk, then non-overlapping parts of subsequent chunks
  // This is imperfect but handles most cases
  const result: string[] = [chunks[0]];

  for (let i = 1; i < chunks.length; i++) {
    const prevChunk = chunks[i - 1];
    const currChunk = chunks[i];

    // Find overlap by looking for common suffix/prefix
    // Try to find where the previous chunk ends in the current chunk
    const prevSentences = splitSentences(prevChunk);
    const currSentences = splitSentences(currChunk);

    // Find how many sentences from prev are at the start of curr
    let overlapCount = 0;
    for (let j = 0; j < Math.min(prevSentences.length, currSentences.length); j++) {
      // Check if last N sentences of prev match first N sentences of curr
      const prevEnd = prevSentences.slice(-(j + 1));
      const currStart = currSentences.slice(0, j + 1);

      if (prevEnd.join(" ") === currStart.join(" ")) {
        overlapCount = j + 1;
      }
    }

    // Add non-overlapping portion
    if (overlapCount > 0 && overlapCount < currSentences.length) {
      result.push(currSentences.slice(overlapCount).join(" "));
    } else if (overlapCount === 0) {
      // No detected overlap, add full chunk
      result.push(currChunk);
    }
    // If overlapCount === currSentences.length, skip (fully contained)
  }

  return result.join(" ");
}
