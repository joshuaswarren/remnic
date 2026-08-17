/**
 * Per-script closed-class cue tables and script-agnostic signal helpers
 * shared by the recall planner heuristics (issue #2191).
 *
 * English keyword regexes stay in their consumers. These tables seed the
 * top ~10 languages so non-English prompts route to the same recall modes
 * as their English equivalents. Substring cues are curated so pure-ASCII
 * entries are multi-word phrases (or non-English single words) that cannot
 * occur in English text — the English corpus behavior is unchanged.
 */

const ASCII_CHARS = /[\u0000-\u007f]/g;
const LETTER_RE = /\p{L}/u;
const WORDISH_RE = /[\p{L}\p{N}]/u;
const QUESTION_MARK_END_RE = /[?？؟]$/u;
const COLON_TERMINATED_RE = /[:：]\s*$/u;

/** True when the text contains a letter outside ASCII — the English keyword
 * tables cannot be assumed to apply. */
export function hasNonAsciiLetter(text: string): boolean {
  return LETTER_RE.test(text.replace(ASCII_CHARS, ""));
}

/** Strip trailing punctuation/symbols/emojis (Unicode-aware) so exact-match
 * ack detection works for "はい。", "merci !", "شكرا" etc. */
export function stripTrailingRecallNoise(text: string): string {
  let candidate = text;
  while (candidate.length > 0) {
    const last = candidate.at(-1) ?? "";
    if (WORDISH_RE.test(last)) break;
    candidate = candidate.slice(0, -1);
  }
  return candidate.trim();
}

/** True when the text ends with an ASCII, fullwidth, or Arabic question mark. */
export function endsWithQuestionMark(text: string): boolean {
  return QUESTION_MARK_END_RE.test(text.trimEnd());
}

export function containsRecallCue(text: string, cues: readonly string[]): boolean {
  const normalized = text.toLowerCase();
  return cues.some((cue) => normalized.includes(cue));
}

// Exact-match acknowledgements (lowercased, trailing noise stripped).
const ACK_CANDIDATES = new Set([
  // English (membership identical to the previous regex alternation)
  "ok", "okay", "kk", "thanks", "thx", "got it", "sounds good", "yep", "yes",
  "nope", "no", "done", "cool", "works",
  // Japanese
  "はい", "うん", "わかった", "わかりました", "了解", "承知", "ありがとう",
  "どうも", "おけー", "オッケー", "りょうかい",
  // Chinese
  "好", "好的", "嗯", "对", "行", "可以", "收到", "明白", "明白了", "知道了",
  "谢谢", "没问题",
  // Korean
  "네", "응", "알겠어", "알겠습니다", "고마워", "감사합니다", "좋아",
  // Spanish
  "sí", "si", "gracias", "vale", "de acuerdo", "perfecto", "claro", "listo",
  // French
  "oui", "merci", "d'accord", "bien", "parfait", "compris", "ça marche",
  // German
  "ja", "danke", "gut", "verstanden", "alles klar", "passt", "einverstanden",
  // Portuguese
  "sim", "obrigado", "obrigada", "certo", "combinado", "beleza",
  // Russian
  "да", "спасибо", "ок", "хорошо", "понял", "поняла", "ясно", "угу", "принято",
  // Arabic
  "نعم", "شكرا", "حسنا", "تمام", "طيب", "موافق", "أوكي",
  // Hindi
  "हाँ", "ठीक", "अच्छा", "धन्यवाद", "समझ गया", "मंज़ूर",
]);

export function isMultilingualAck(candidate: string): boolean {
  return ACK_CANDIDATES.has(candidate.trim().toLowerCase());
}

// Timeline / sequence / what-happened cues → graph_mode parity.
export const GRAPH_MODE_CUES: readonly string[] = [
  // Japanese
  "タイムライン", "時系列", "時の流れ", "順序", "経緯", "変遷", "何があった", "どうなった",
  // Chinese
  "时间线", "时间轴", "时间顺序", "先后顺序", "来龙去脉", "变迁", "发生了什么", "怎么演变",
  // Korean
  "타임라인", "시간순", "경위", "변천", "무슨 일이 있었", "어떻게 됐", "어떻게 변했",
  // Spanish
  "línea de tiempo", "cronología", "cronologia", "qué pasó", "qué ocurrió", "historial",
  // French
  "chronologie", "frise chronologique", "qu'est-il passé", "historique",
  // German
  "zeitleiste", "abfolge", "ereignisfolge", "was ist passiert", "verlauf",
  // Portuguese
  "linha do tempo", "sequência de eventos", "o que aconteceu",
  // Russian
  "хронология", "последовательность событий", "что произошло", "таймлайн",
  // Arabic
  "الجدول الزمني", "التسلسل الزمني", "تسلسل الأحداث", "ماذا حدث",
  // Hindi
  "टाइमलाइन", "कालक्रम", "घटनाक्रम", "क्या हुआ",
];

// Causal-chain cues (broad graph intent).
export const CAUSAL_CHAIN_CUES: readonly string[] = [
  "原因", "因果", "根本原因", "怎么会",
  "原因は", "なぜそうなった", "因果関係",
  "원인이", "왜 이렇게", "인과",
  "por qué pasó", "causa raíz", "cadena de causas",
  "pourquoi c'est arrivé", "cause racine",
  "wieso ist das passiert", "ursachenkette",
  "por que aconteceu", "cadeia de causas",
  "почему это произошло", "первопричина", "причинно",
  "لماذا حدث هذا", "سلسلة الأسباب",
  "ऐसा क्यों हुआ", "मूल कारण",
];

// Temporal-ordering markers → chronological evidence tier parity.
export const EVENT_ORDER_CUES: readonly string[] = [
  // Japanese
  "最初", "初めて", "いつ", "何日", "何ヶ月", "何か月", "前に", "後で", "以降",
  "順番", "順に", "前回", "さかのぼ", "最近",
  // Chinese
  "第一", "最早", "最后一次", "上次", "什么时候", "几月", "几天", "几个月",
  "之前", "之后", "顺序", "按时间", "最近",
  // Korean
  "처음", "언제", "며칠", "몇 달", "몇 개월", "전에", "후에", "순서대로", "지난번",
  // Spanish
  "cuándo", "cuando fue", "cuántos días", "cuántos meses", "primero", "última vez",
  "por orden", "orden cronológico",
  // French
  "quand ", "combien de jours", "combien de mois", "la première fois",
  "la dernière fois", "dans l'ordre",
  // German
  "wann ", "wie viele tage", "wie viele monate", "zum ersten", "das letzte mal",
  // Portuguese
  "quando foi", "quantos dias", "quantos meses", "primeira vez", "última vez",
  // Russian
  "когда", "сколько дней", "сколько месяцев", "впервые", "последний раз", "по порядку",
  // Arabic
  "متى", "كم يوم", "كم شهر", "أول مرة", "آخر مرة", "بالترتيب",
  // Hindi
  "कब", "कितने दिन", "कितने महीने", "पहली बार", "आख़िरी बार",
];

// Timing/detail question cues for the response-guidance dates intent.
export const TIMING_DETAIL_CUES: readonly string[] = [
  "いつ", "日時", "期日", "締め切り", "締切",
  "什么时候", "几点", "日期", "截止",
  "언제", "날짜", "마감",
  "qué día", "qué fecha", "fecha límite", "cuándo",
  "quelle date", "date limite",
  "welches datum", "frist",
  "que dia", "que data", "prazo",
  "какого числа", "дедлайн",
  "تاريخ الموعد", "متى الموعد",
  "तारीख",
];

// Contradiction-resolution cues for the response-guidance tier.
export const CONTRADICTION_CUES: readonly string[] = [
  "矛盾", "食い違", "前と違う", "一貫して",
  "不一致", "之前说的", "前后矛盾",
  "모순", "일관되",
  "contradice", "inconsistente", "antes dijiste",
  "contredit", "incohérent", "tu avais dit",
  "widerspricht", "widersprüchlich",
  "contradiz",
  "противореч", "непоследовательн",
  "يناقض", "تعارض",
  "विरोधाभास",
];

// Prompt-filler words (recall verbs in other languages) that must not count
// as content discriminators in the direct-answer gate.
export const MULTILINGUAL_PROMPT_RECALL_WORDS: readonly string[] = [
  "教えて", "見せて", "探して", "一覧",
  "告诉我", "显示", "查找",
  "보여줘", "알려줘", "찾아줘",
  "muestra", "busca", "encuentra",
  "montre", "cherche",
  "zeige", "suche",
  "покажи",
  "أظهر", "ابحث",
  "दिखाओ", "खोजो",
];

/** Structural heading line for non-Latin scripts: colon-terminated, short,
 * and containing a non-ASCII letter. English prompts are unaffected. */
export function isNonLatinHeadingLine(line: string): boolean {
  if (line.length > 80) return false;
  if (!COLON_TERMINATED_RE.test(line)) return false;
  return hasNonAsciiLetter(line);
}
