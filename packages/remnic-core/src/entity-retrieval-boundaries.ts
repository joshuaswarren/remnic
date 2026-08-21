const UNICODE_WORD_OR_NUMBER_RE = /[\p{L}\p{M}\p{N}]/u;

function firstUnicodeCharacter(value: string): string {
  const codePoint = value.codePointAt(0);
  return codePoint === undefined ? "" : String.fromCodePoint(codePoint);
}

function lastUnicodeCharacter(value: string): string {
  const codePoint = [...value].at(-1);
  return codePoint ?? "";
}

const JAPANESE_PARTICLE_RE = /^[のはがをにへともやかでだ]$/u;
const JAPANESE_MULTI_CHARACTER_PARTICLES = [
  "について",
  "にとって",
  "によって",
  "に関して",
  "に対して",
  "とは",
  "では",
  "には",
  "にも",
  "って",
] as const;
const KOREAN_PARTICLES = [
  "에서", "에게", "한테", "으로", "까지", "부터", "보다", "처럼", "같이",
  "이나", "라도", "밖에", "마다", "조차", "이랑", "하고", "은", "는",
  "이", "가", "을", "를", "의", "께", "와", "과", "도", "만", "든",
  "에", "로", "나", "랑",
] as const;
const KOREAN_UNSPACED_QUESTION_PARTICLES = ["은", "는", "이", "가"] as const;
const KOREAN_INTERROGATIVE_PREFIXES = [
  "어디", "무엇", "뭐", "왜", "어떻게", "언제", "누구", "어느", "몇", "얼마",
] as const;

const HANGUL_RUN_RE = /^[\p{Script=Hangul}]+/u;

const UNICODE_WORD_SEGMENTER =
  typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "word" }) : null;
const KOREAN_WORD_SEGMENTER =
  typeof Intl.Segmenter === "function" ? new Intl.Segmenter("ko", { granularity: "word" }) : null;

const JAPANESE_WORD_SEGMENTER =
  typeof Intl.Segmenter === "function" ? new Intl.Segmenter("ja", { granularity: "word" }) : null;
const JAPANESE_KANA_RE = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;

function isJapaneseParticleBoundary(suffix: string): boolean {
  const firstSegment = JAPANESE_WORD_SEGMENTER?.segment(suffix).containing(0)?.segment;
  if (firstSegment !== undefined) {
    if (JAPANESE_MULTI_CHARACTER_PARTICLES.some((particle) => particle === firstSegment)) return true;
    return JAPANESE_PARTICLE_RE.test(firstSegment);
  }
  const firstCharacter = firstUnicodeCharacter(suffix);
  return (
    JAPANESE_MULTI_CHARACTER_PARTICLES.some((particle) => suffix.startsWith(particle)) ||
    (JAPANESE_PARTICLE_RE.test(firstCharacter) &&
      !UNICODE_WORD_OR_NUMBER_RE.test(firstUnicodeCharacter(suffix.slice(firstCharacter.length))))
  );
}

function isIntlWordBoundary(source: string, index: number): boolean {
  if (index <= 0 || index >= source.length) return true;
  return UNICODE_WORD_SEGMENTER?.segment(source).containing(index)?.index === index;
}

function isStandaloneJapaneseLeadingParticle(
  particle: string,
  source: string,
  boundaryIndex: number,
): boolean {
  if (!JAPANESE_WORD_SEGMENTER || boundaryIndex <= 0 || !JAPANESE_PARTICLE_RE.test(particle)) {
    return false;
  }
  const particleStart = boundaryIndex - particle.length;
  const segment = JAPANESE_WORD_SEGMENTER.segment(source).containing(particleStart);
  return segment?.index === particleStart
    && segment.index + segment.segment.length === boundaryIndex;
}
function isKoreanUnspacedQuestionBoundary(suffix: string): boolean {
  return KOREAN_UNSPACED_QUESTION_PARTICLES.some((particle) =>
    suffix.startsWith(particle) &&
    KOREAN_INTERROGATIVE_PREFIXES.some((prefix) => suffix.startsWith(prefix, particle.length)),
  );
}

function isKoreanParticleBoundary(suffix: string): boolean {
  if (isKoreanUnspacedQuestionBoundary(suffix)) return true;
  const firstSegment = KOREAN_WORD_SEGMENTER?.segment(suffix).containing(0)?.segment;
  if (firstSegment !== undefined) {
    return KOREAN_PARTICLES.some((particle) => particle === firstSegment);
  }
  const particleRun = suffix.match(HANGUL_RUN_RE)?.[0] ?? "";
  const nextCharacter = firstUnicodeCharacter(suffix.slice(particleRun.length));
  return (
    KOREAN_PARTICLES.some((particle) => particle === particleRun) &&
    (nextCharacter.length === 0 || !UNICODE_WORD_OR_NUMBER_RE.test(nextCharacter))
  );
}

function isUnicodePhraseBoundary(
  character: string,
  suffix: string = "",
  source: string = "",
  boundaryIndex: number = -1,
  strictUnicode = false,
): boolean {
  return (
    character.length === 0
    || !UNICODE_WORD_OR_NUMBER_RE.test(character)
    || isJapaneseParticleBoundary(suffix)
    || (!strictUnicode &&
      boundaryIndex >= 0 &&
      !JAPANESE_KANA_RE.test(suffix) &&
      isIntlWordBoundary(source, boundaryIndex))
    || isKoreanParticleBoundary(suffix)
  );
}

export function containsPhrase(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const caseInsensitive = /^[a-z0-9 ]+$/i.test(needle);
  const searchHaystack = caseInsensitive ? haystack.toLowerCase() : haystack;
  const searchNeedle = caseInsensitive ? needle.toLowerCase() : needle;
  let offset = searchHaystack.indexOf(searchNeedle);
  while (offset >= 0) {
    const before = lastUnicodeCharacter(searchHaystack.slice(0, offset));
    const after = searchHaystack.slice(offset + searchNeedle.length);
    if (
      (
        isUnicodePhraseBoundary(before, "", searchHaystack, offset, caseInsensitive)
        || isStandaloneJapaneseLeadingParticle(before, searchHaystack, offset)
      )
      && isUnicodePhraseBoundary(
        firstUnicodeCharacter(after),
        after,
        searchHaystack,
        offset + searchNeedle.length,
        caseInsensitive,
      )
    ) {
      return true;
    }
    offset = searchHaystack.indexOf(searchNeedle, offset + searchNeedle.length);
  }
  return false;
}
