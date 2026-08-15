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
 *
 * The scan stays linear and does not use a backtracking regular expression.
 * ASCII punctuation keeps its old whitespace rule. Unicode terminators also
 * split when the next sentence starts immediately, as in CJK text.
 */
const UNICODE_SENTENCE_TERMINATORS = "。．！？؟۔।॥｡…";
const ASCII_SENTENCE_TERMINATORS = ".!?";
const CJK_NO_SPACE_TERMINATORS = "。．！？｡";
const CLOSING_PUNCTUATION = "\"'”’»」』）］】〉》)]}";
const DIGITS = "0123456789０１２３４５６７８９";
const SENTENCE_SEGMENTER =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "sentence" })
    : undefined;

function isSentenceTerminator(character: string): boolean {
  return (
    ASCII_SENTENCE_TERMINATORS.includes(character) ||
    UNICODE_SENTENCE_TERMINATORS.includes(character)
  );
}

function isCjk(character: string): boolean {
  return /[\u3000-\u9fff\uf900-\ufaff\uac00-\ud7af]/u.test(character);
}

type SentenceList = string[] & { separators: string[] };

function splitSentencesFallback(text: string): SentenceList {
  const sentences = [] as unknown as SentenceList;
  Object.defineProperty(sentences, "separators", {
    value: [],
    writable: true,
  });
  let start = 0;
  let separator = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!isSentenceTerminator(ch)) continue;

    let end = i;
    let hasUnicodeTerminator = UNICODE_SENTENCE_TERMINATORS.includes(ch);
    while (end + 1 < text.length && isSentenceTerminator(text[end + 1])) {
      end++;
      hasUnicodeTerminator ||= UNICODE_SENTENCE_TERMINATORS.includes(text[end]);
    }

    const isFullwidthDecimal =
      ch === "．" &&
      DIGITS.includes(text[i - 1] ?? "") &&
      DIGITS.includes(text[end + 1] ?? "");
    while (end + 1 < text.length && CLOSING_PUNCTUATION.includes(text[end + 1])) {
      end++;
    }

    const after = text[end + 1];
    const boundary =
      !isFullwidthDecimal &&
      (hasUnicodeTerminator || after === undefined || /\s/u.test(after));
    if (boundary) {
      const sentence = text.slice(start, end + 1).trim();
      if (sentence.length > 0) {
        sentences.push(sentence);
        if (sentences.length > 1) sentences.separators.push(separator);
      }
      let nextStart = end + 1;
      while (nextStart < text.length && /\s/u.test(text[nextStart])) nextStart++;
      separator = text.slice(end + 1, nextStart);
      start = nextStart;
    }
    i = end;
  }

  const remaining = text.slice(start).trim();
  if (remaining.length > 0) {
    sentences.push(remaining);
    if (sentences.length > 1) sentences.separators.push(separator);
  }
  return sentences;
}
export function splitSentences(text: string): string[] {
  const canUseSegmenter =
    SENTENCE_SEGMENTER !== undefined &&
    !/\s/u.test(text) &&
    [...text].some((character) => UNICODE_SENTENCE_TERMINATORS.includes(character));
  if (canUseSegmenter) {
    const segments = Array.from(SENTENCE_SEGMENTER.segment(text), ({ segment }) =>
      segment.trim(),
    ).filter((segment) => segment.length > 0) as SentenceList;
    if (
      segments.length > 1 &&
      segments.slice(0, -1).every((segment) =>
        [...segment].some((character) =>
          UNICODE_SENTENCE_TERMINATORS.includes(character),
        ),
      )
    ) {
      Object.defineProperty(segments, "separators", {
        value: Array(segments.length - 1).fill(""),
        writable: true,
      });
      return segments;
    }
  }
  return splitSentencesFallback(text);
}

function endsWithoutSpace(text: string): boolean {
  let index = text.length - 1;
  while (index >= 0 && CLOSING_PUNCTUATION.includes(text[index])) index--;
  const terminator = text[index] ?? "";
  if (CJK_NO_SPACE_TERMINATORS.includes(terminator)) {
    return isCjk(text[index - 1] ?? "");
  }
  return terminator === "…" && isCjk(text[index - 1] ?? "");
}
export function joinSentences(sentences: string[]): string {
  let result = "";
  const separators = (sentences as Partial<SentenceList>).separators;
  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i];
    if (result.length > 0) {
      const separator = separators?.[i - 1];
      result += separator ?? (endsWithoutSpace(result) ? "" : " ");
    }
    result += sentence;
  }
  return result;
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
      const chunkContent = joinSentences(currentChunkSentences);
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

      if (joinSentences(prevEnd) === joinSentences(currStart)) {
        overlapCount = j + 1;
      }
    }

    // Add non-overlapping portion
    if (overlapCount > 0 && overlapCount < currSentences.length) {
      result.push(joinSentences(currSentences.slice(overlapCount)));
    } else if (overlapCount === 0) {
      // No detected overlap, add full chunk
      result.push(currChunk);
    }
    // If overlapCount === currSentences.length, skip (fully contained)
  }

  return joinSentences(result);
}
