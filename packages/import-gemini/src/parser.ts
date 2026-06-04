// ---------------------------------------------------------------------------
// Gemini (Google Takeout "Gemini Apps Activity") parser (issue #568 slice 4)
// ---------------------------------------------------------------------------

import { parseIsoOffsetTimestamp } from "@remnic/core";
//
// Google Takeout bundles Gemini Apps activity into `My Activity.json` (and a
// legacy `MyActivity.json` spelling). Each record represents one prompt the
// user sent. The schema is stable across exports we have observed:
//
//   {
//     "header": "Gemini Apps",
//     "title": "Asked: <user prompt>",          // older exports
//     "text":  "<user prompt>",                 // newer exports
//     "titleUrl": "https://gemini.google.com/...",
//     "time": "2026-02-14T09:30:00.000Z",
//     "products": ["Gemini Apps"],
//     "subtitles": [{ "name": "Model: Gemini X" }]
//   }
//
// Prompts are pre-extracted by Google (no DOM scraping). The user prompt text
// lives in `text`, or inside `title` as "Asked: <prompt>" for legacy records.
// Assistant responses are NOT exported by Takeout (Google omits them), so
// we only import the user's prompts.
//
// The parser accepts either the raw `My Activity.json` contents (JSON string
// or already-parsed array) or a combined bundle object
// `{ activities: [...] }` for future bundle-auto-detect (PR 7).

// ---------------------------------------------------------------------------
// Raw export shapes
// ---------------------------------------------------------------------------

/**
 * A single Gemini Apps activity record. Other `header` values (Search, Maps,
 * YouTube) co-exist in the same file when the user exports multiple products;
 * we filter to Gemini Apps only.
 */
export interface GeminiActivityRecord {
  header?: string;
  title?: string;
  titleUrl?: string;
  /** Newer exports put the prompt text here. */
  text?: string;
  /** ISO 8601 timestamp of the prompt. */
  time?: string;
  products?: string[];
  subtitles?: Array<{ name?: string; url?: string }>;
  /** Some exports embed the model response as a follow-up subtitle. */
  details?: Array<{ name?: string }>;
}

const UTC_ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]00:00)$/;

export interface ParsedGeminiExport {
  /** Prompts filtered to `header === "Gemini Apps"`. */
  activities: GeminiActivityRecord[];
  filePath?: string;
}

// ---------------------------------------------------------------------------
// Public parse API
// ---------------------------------------------------------------------------

export interface GeminiParseOptions {
  strict?: boolean;
  filePath?: string;
  /**
   * When true, keep records even if their header is not "Gemini Apps".
   * Default false — we only import Gemini activity.
   */
  keepNonGemini?: boolean;
}

/**
 * Parse a Takeout activity payload. Accepts a JSON string, parsed object, or
 * parsed array. Non-Gemini records are filtered out by default.
 */
export function parseGeminiExport(input: unknown, options: GeminiParseOptions = {}): ParsedGeminiExport {
  // File-backed adapter contract: `runImportCommand` passes `undefined` when
  // `--file` is omitted. Gemini is a file-only importer (Takeout doesn't
  // expose an API), so a missing payload MUST surface as a user-facing
  // error rather than silently succeeding with 0 memories. Cursor review
  // on PR #600 flagged the silent-success path.
  if (input === undefined || input === null) {
    throw new Error(
      "The 'gemini' importer requires a file. Pass `--file <path>` pointing at " +
        "your Google Takeout `My Activity.json` (Gemini Apps section)."
    );
  }
  const raw = coerceJson(input);
  const result: ParsedGeminiExport = {
    activities: [],
    ...(options.filePath !== undefined ? { filePath: options.filePath } : {}),
  };

  if (Array.isArray(raw)) {
    appendActivities(result.activities, raw, options);
    return result;
  }

  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    // Common wrapper shapes: { activities: [...] } or { MyActivity: [...] }.
    let sawKnownKey = false;
    for (const key of ["activities", "MyActivity", "activity"] as const) {
      const v = obj[key];
      if (Array.isArray(v)) {
        sawKnownKey = true;
        appendActivities(result.activities, v, options);
      }
    }
    // Codex review on PR #600: pointing --file at a random JSON object
    // (e.g. a config file) used to report a successful 0-memory import.
    // We now throw a user-facing error when no known wrapper key was
    // present. This differs from strict mode because the "array or
    // object" shape check already passed — we just didn't find anything
    // that looked like a Gemini export inside the object.
    if (!sawKnownKey) {
      throw new Error(
        "Gemini export object has no recognized activity key. Expected one of " +
          "'activities', 'MyActivity', or 'activity'. Point --file at your " +
          "Google Takeout `My Activity.json` (Gemini Apps section)."
      );
    }
    return result;
  }

  // Codex review on PR #600 — primitive payloads (numbers, booleans,
  // strings, etc.) must always throw, regardless of strict mode. Silently
  // returning a 0-memory success on a JSON primitive (e.g. `true`,
  // `"text"`, `123`) hides operator input mistakes and makes automation
  // treat a broken import as healthy. Report the actual received value —
  // `typeof null === "object"` is the JS trap CLAUDE.md rule 18 calls
  // out. Using describeType() sidesteps the "received object" message
  // for null inputs.
  throw new Error(`Gemini export must be a JSON array or object; received ${describeType(raw)}`);
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  return typeof value;
}

function appendActivities(dest: GeminiActivityRecord[], src: unknown[], options: GeminiParseOptions): void {
  for (const entry of src) {
    if (!entry || typeof entry !== "object") {
      if (options.strict) {
        throw new Error("Gemini activity entry must be an object");
      }
      continue;
    }
    const record = entry as GeminiActivityRecord;
    if (!options.keepNonGemini && !isGeminiRecord(record)) continue;
    validateGeminiTimestamp(record.time);
    dest.push(record);
  }
}

function validateGeminiTimestamp(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Gemini activity time must be an ISO-8601 UTC timestamp");
  }
  if (!UTC_ISO_INSTANT_RE.test(value)) {
    throw new Error("Gemini activity time must be an ISO-8601 UTC timestamp");
  }
  if (parseIsoOffsetTimestamp(value) === null) {
    throw new Error("Gemini activity time must be a valid ISO-8601 UTC timestamp");
  }
}

function isGeminiRecord(record: GeminiActivityRecord): boolean {
  if (record.header === "Gemini Apps") return true;
  if (record.header === "Bard") return true; // pre-rebrand exports
  if (Array.isArray(record.products) && record.products.some((p) => p === "Gemini Apps" || p === "Bard")) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function coerceJson(input: unknown): unknown {
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch (err) {
      throw new Error(`Gemini export is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return input;
}

/**
 * Extract the user prompt text from an activity record. Newer exports put it
 * in `text`; older ones nest it inside `title` as "Asked: <prompt>". Returns
 * `undefined` when no usable prompt is present.
 */
export function extractUserPrompt(record: GeminiActivityRecord): string | undefined {
  if (typeof record.text === "string") {
    const t = record.text.trim();
    if (t.length > 0) return t;
  }
  if (typeof record.title === "string") {
    const t = record.title.trim();
    if (t.length === 0) return undefined;
    // Strip legacy prefixes that Takeout added in older exports.
    const stripped = t.replace(/^(Asked|Prompted|Searched|Typed):\s*/i, "");
    return stripped.length > 0 ? stripped : undefined;
  }
  return undefined;
}
