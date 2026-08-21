import type { SchemaTierPage } from "../../fixtures/schema-tiers/index.js";

export interface ExtractRankedPageIdsOptions {
  preserveDuplicateRankSlots?: boolean;
}

export function extractRankedPageIds(
  recallText: string,
  pages: SchemaTierPage[],
  options: ExtractRankedPageIdsOptions = {}
): string[] {
  const pageIdByLowercase = new Map(pages.map((page) => [page.id.toLowerCase(), page.id]));

  const rankedPageIds = collectPageIdMarkers(recallText)
    .sort((left, right) => {
      if (left.index !== right.index) {
        return left.index - right.index;
      }
      return left.id.localeCompare(right.id);
    })
    .map((match) => resolvePageId(match.id, pageIdByLowercase));

  const seenKnown = new Map<string, number>();
  const out: string[] = [];
  for (const pageId of rankedPageIds) {
    if (!pageId.known) {
      out.push(pageId.id);
      continue;
    }

    const seenCount = seenKnown.get(pageId.id) ?? 0;
    seenKnown.set(pageId.id, seenCount + 1);
    if (seenCount === 0) {
      out.push(pageId.id);
    } else if (options.preserveDuplicateRankSlots) {
      out.push(formatDuplicatePageIdSlot(pageId.id, seenCount + 1));
    }
  }
  return out;
}

function resolvePageId(markerId: string, pageIdByLowercase: Map<string, string>): { id: string; known: boolean } {
  const normalizedMarkerId = stripLeadingFormattingDelimiters(markerId).toLowerCase();
  const exact = pageIdByLowercase.get(normalizedMarkerId);
  if (exact !== undefined) {
    return { id: exact, known: true };
  }

  let candidate = normalizedMarkerId;
  while (
    candidate.length > 0 &&
    isTrailingFormattingDelimiter(candidate.charCodeAt(candidate.length - 1), { includePeriod: true })
  ) {
    candidate = candidate.slice(0, -1);
    const known = pageIdByLowercase.get(candidate);
    if (known !== undefined) {
      return { id: known, known: true };
    }
  }

  return { id: stripTrailingFormattingDelimiters(normalizedMarkerId), known: false };
}

function formatDuplicatePageIdSlot(pageId: string, ordinal: number): string {
  return `__duplicate_page_id_slot__:${ordinal}:${pageId}`;
}

function collectPageIdMarkers(recallText: string): Array<{ id: string; index: number }> {
  const out: Array<{ id: string; index: number }> = [];
  const lowerRecallText = recallText.toLowerCase();
  const marker = "page_id:";
  let searchStart = 0;

  while (searchStart < lowerRecallText.length) {
    const markerIndex = lowerRecallText.indexOf(marker, searchStart);
    if (markerIndex < 0) break;
    if (!hasMarkerBoundaryBefore(lowerRecallText, markerIndex)) {
      searchStart = markerIndex + marker.length;
      continue;
    }

    let valueStart = markerIndex + marker.length;
    while (valueStart < lowerRecallText.length && isAsciiHorizontalWhitespace(lowerRecallText.charCodeAt(valueStart))) {
      valueStart += 1;
    }

    let valueEnd = valueStart;
    while (valueEnd < lowerRecallText.length && !isAsciiWhitespace(lowerRecallText.charCodeAt(valueEnd))) {
      valueEnd += 1;
    }

    const pageId = lowerRecallText.slice(valueStart, valueEnd);
    if (pageId.length > 0) {
      out.push({ id: pageId, index: markerIndex });
    }
    searchStart = valueEnd;
  }

  return out;
}

function hasMarkerBoundaryBefore(value: string, markerIndex: number): boolean {
  if (markerIndex === 0) {
    return true;
  }
  return !isAsciiIdentifier(value.charCodeAt(markerIndex - 1));
}

function isAsciiWhitespace(code: number): boolean {
  return code === 9 || code === 10 || code === 13 || code === 32;
}

function isAsciiHorizontalWhitespace(code: number): boolean {
  return code === 9 || code === 32;
}

function isAsciiIdentifier(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || code === 95 || (code >= 97 && code <= 122);
}

function stripTrailingFormattingDelimiters(value: string): string {
  let end = value.length;
  while (end > 0 && isTrailingFormattingDelimiter(value.charCodeAt(end - 1), { includePeriod: false })) {
    end -= 1;
  }
  return value.slice(0, end);
}

function stripLeadingFormattingDelimiters(value: string): string {
  let start = 0;
  while (start < value.length && isLeadingFormattingDelimiter(value.charCodeAt(start))) {
    start += 1;
  }
  return value.slice(start);
}

function isLeadingFormattingDelimiter(code: number): boolean {
  return code === 34 || code === 39 || code === 40 || code === 91 || code === 123;
}

function isTrailingFormattingDelimiter(code: number, options: { includePeriod: boolean }): boolean {
  if (options.includePeriod && code === 46) {
    return true;
  }

  return (
    code === 33 ||
    code === 34 ||
    code === 39 ||
    code === 41 ||
    code === 44 ||
    code === 58 ||
    code === 59 ||
    code === 63 ||
    code === 93 ||
    code === 125
  );
}
