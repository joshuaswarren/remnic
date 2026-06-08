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
  // Split on sentence-ending punctuation (. ! ?) that is followed by whitespace
  // or end of string; the punctuation stays with the sentence.
  //
  // Implemented as a single linear scan rather than a regex. Every regex form of
  // this split is either polynomial (CodeQL js/polynomial-redos) or — once
  // bounded/anchored to satisfy CodeQL — mishandles long runs or non-boundary
  // punctuation (a global match silently drops a skipped prefix; a sticky match
  // stops at the first interior `.` that is not a real boundary, e.g. "v1.2.3"
  // or "example.com", emitting the whole document as one chunk). A character
  // scan is O(n), allocation-free, drops nothing, and treats interior
  // punctuation correctly. Normal prose splits identically to the previous
  // /[^.!?]*[.!?]+(?:\s+|$)/g form.
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    // Consume a run of terminators (e.g. "?!", "...").
    let end = i;
    while (end + 1 < text.length) {
      const n = text[end + 1];
      if (n !== "." && n !== "!" && n !== "?") break;
      end++;
    }
    const after = text[end + 1];
    // A real boundary only if the terminator run ends the string or is followed
    // by whitespace. Interior punctuation (no following whitespace) is left in
    // place and the scan continues.
    if (after === undefined || /\s/.test(after)) {
      const sentence = text.slice(start, end + 1).trim();
      if (sentence.length > 0) sentences.push(sentence);
      start = end + 1;
    }
    i = end;
  }
  // Trailing text without a closing terminator.
  if (start < text.length) {
    const remaining = text.slice(start).trim();
    if (remaining.length > 0) sentences.push(remaining);
  }
  return sentences;
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
