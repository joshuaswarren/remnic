# Import adapters reject payloads that cannot be an export with a user-facing error instead of a silent zero-memory success

Status: accepted

## Context
The import CLI passes `undefined` to a parser when `--file` is omitted, JSON happily parses into primitives, and users point `--file` at arbitrary JSON objects such as config files. A parser that returns an empty result on any of these produces a success that looks like a healthy zero-memory import in automation logs while the export was never read — every import adapter review (PRs #595, #598, #600) flagged one of these silent-success paths. At the same time, export shapes drift over time, so rejecting anything unfamiliar would break future imports, and junk entries inside an otherwise valid payload should not fail a large import. Reviews also established where file decoding lives: parsers receive already-decoded contents and never open archives themselves.

## Decision
A parse call whose input cannot be an export at all throws a user-facing error, regardless of strict mode:

- Missing input (`undefined` / `null`): throw, and report the actual received type — `typeof null === "object"`, so the message must say "null" (use `describeType`, not `typeof`).
- JSON primitive payloads (number, boolean, string): always throw.
- Objects carrying none of the adapter's recognized top-level sections: throw. For Claude that means neither `conversations` nor `projects`; for Gemini, none of the known activity keys. A shape check that merely passed "is an object" is not enough.

Parsers receive decoded file contents from the CLI; they never read ZIP archives themselves, and fixtures mirror the real export shapes.

Strict mode tightens object-level checks: an object that is structurally ambiguous for the adapter throws rather than silently returning an empty struct, and Claude project entries require an unambiguous project signal (`prompt_template` or `docs`) — a name-only array like `[{"name": "foo"}]` is rejected in strict mode. Non-strict mode keeps the lenient fallbacks to survive future shape changes. Inside an accepted payload, individual malformed entries are dropped rather than failing the whole import (mem0 parser leniency protects against server-side schema drift).

Adapter registration stays an import-time side effect so the public "import registers the adapter" contract cannot silently become false, and synthetic fixtures mirror the CLI's contract (the CLI reads the file, the parser receives contents).

## Consequences
Broken invocations fail loudly and cannot be mistaken for healthy zero-memory runs in automation. The cost: each adapter must maintain explicit reject lists and error messages that describe the received value precisely, strict-mode section checks must grow whenever an export shape gains new sections, and lenient mode may still drop drifted entries — silently by design, and visibly only through counts.

Note: Merged into this theme to stay within the ten-file limit: the WeClone adapter-registration and CLI-fixture-contract records (3) — nearest neighbour, the adapter boundary contract.

## Origin comments
- `packages/import-chatgpt/src/parser.ts:231` — "// Primitive / unparseable payloads must NEVER return an empty success —"
- `packages/import-chatgpt/src/parser.ts:232` — "// that would mask operator mistakes and allow automation to treat a"
- `packages/import-chatgpt/src/parser.ts:233` — "// broken import as a clean "0 memories" import. Throw regardless of"
- `packages/import-chatgpt/src/parser.ts:234` — "// strict mode. Codex review on PR #595."
- `packages/import-chatgpt/src/parser.ts:300` — "// Soft-deleted; skip even in strict mode (it's a valid shape, just not a"
- `packages/import-chatgpt/src/parser.ts:301` — "// memory the user wants imported)."
- `packages/import-claude/src/parser.test.ts:81` — "// Cursor review on PR #598 — strict mode should reject object payloads"
- `packages/import-claude/src/parser.test.ts:82` — "// that have none of the recognized Claude export sections rather than"
- `packages/import-claude/src/parser.test.ts:83` — "// silently returning an empty struct."
- `packages/import-claude/src/parser.test.ts:122` — "// Codex review on PR #598 — when `--file` is omitted, the parser receives"
- `packages/import-claude/src/parser.test.ts:123` — "// `undefined`; we must throw a user-facing hint instead of returning an"
- `packages/import-claude/src/parser.test.ts:124` — "// empty result that looks like a successful zero-memory import."
- `packages/import-claude/src/parser.test.ts:130` — "// Codex review on PR #598 — primitive payloads (numbers, booleans,"
- `packages/import-claude/src/parser.test.ts:131` — "// strings) must always throw regardless of strict mode."
- `packages/import-claude/src/parser.test.ts:141` — "// Codex review on PR #598 — the `name`-only project fallback is too"
- `packages/import-claude/src/parser.test.ts:142` — "// loose for strict mode; an arbitrary `[{"name": "foo"}]` would slip past"
- `packages/import-claude/src/parser.test.ts:143` — "// strict validation. In strict mode we require an unambiguous project"
- `packages/import-claude/src/parser.test.ts:144` — "// signal (`prompt_template` or `docs`)."
- `packages/import-claude/src/parser.ts:21` — "// We do NOT read ZIP archives here — the CLI reads the file contents and"
- `packages/import-claude/src/parser.ts:22` — "// passes them in. Synthetic fixtures in `fixtures/` mirror the real shapes."
- `packages/import-claude/src/parser.ts:109` — "// Codex review on PR #598 — missing input (undefined / null) must NEVER"
- `packages/import-claude/src/parser.ts:110` — "// succeed as an empty import. The CLI passes `undefined` when `--file`"
- `packages/import-claude/src/parser.ts:111` — "// is omitted; silently returning a zero-memory success would make"
- `packages/import-claude/src/parser.ts:112` — "// `remnic import --adapter claude` without --file look healthy in"
- `packages/import-claude/src/parser.ts:113` — "// automation logs while the user's export was never read."
- `packages/import-claude/src/parser.ts:200` — "// Strict mode: if the object has neither `conversations` nor `projects`,"
- `packages/import-claude/src/parser.ts:201` — "// bail rather than silently returning an empty struct. Non-strict mode"
- `packages/import-claude/src/parser.ts:202` — "// keeps the lenient behavior to survive future-shape changes."
- `packages/import-claude/src/parser.ts:211` — "// Codex review on PR #598 — primitive payloads (numbers, booleans,"
- `packages/import-claude/src/parser.ts:212` — "// strings, etc.) must always throw regardless of strict mode. A silent"
- `packages/import-claude/src/parser.ts:213` — "// empty result on garbage input would let automation mistake a broken"
- `packages/import-claude/src/parser.ts:214` — "// import for a healthy zero-memory run."
- `packages/import-claude/src/parser.ts:254` — "// Projects are recognised by the presence of `prompt_template` OR `docs`"
- `packages/import-claude/src/parser.ts:255` — "// — unambiguous structural signals unique to project exports."
- `packages/import-claude/src/parser.ts:258` — "// Codex review on PR #598 — the `name`-only fallback is too loose for"
- `packages/import-claude/src/parser.ts:259` — "// strict mode. An arbitrary array like `[{"name": "foo"}]` would slip"
- `packages/import-claude/src/parser.ts:260` — "// past strict validation and produce empty imports. In strict mode we"
- `packages/import-claude/src/parser.ts:261` — "// require an unambiguous project signal (prompt_template or docs) and"
- `packages/import-claude/src/parser.ts:262` — "// reject name-only entries. Non-strict mode keeps the lenient fallback"
- `packages/import-claude/src/parser.ts:263` — "// for future-shape safety."
- `packages/import-gemini/src/parser.test.ts:52` — "// Cursor review on PR #600 — parseGeminiExport MUST reject undefined /"
- `packages/import-gemini/src/parser.test.ts:53` — "// null input (what runImportCommand passes when --file is omitted) with"
- `packages/import-gemini/src/parser.test.ts:54` — "// a user-facing error. Silently returning 0 memories masks bad CLI"
- `packages/import-gemini/src/parser.test.ts:55` — "// invocations."
- `packages/import-gemini/src/parser.test.ts:61` — "// Cursor review on PR #600 — the strict-mode error used `typeof raw`"
- `packages/import-gemini/src/parser.test.ts:62` — "// which reports "object" for null (JS trap). The message must say"
- `packages/import-gemini/src/parser.test.ts:63` — "// "null" instead."
- `packages/import-gemini/src/parser.test.ts:68` — "// Codex review on PR #600 — pointing --file at a random JSON object"
- `packages/import-gemini/src/parser.test.ts:69` — "// (e.g. a config file) was reported as "0 memories imported" instead"
- `packages/import-gemini/src/parser.test.ts:70` — "// of surfacing an error. Now throws for objects that lack any of the"
- `packages/import-gemini/src/parser.test.ts:71` — "// recognized activity keys."
- `packages/import-gemini/src/parser.test.ts:77` — "// Codex review on PR #600 — a JSON primitive payload (number, boolean,"
- `packages/import-gemini/src/parser.test.ts:78` — "// quoted string) must always throw regardless of strict mode. Silently"
- `packages/import-gemini/src/parser.test.ts:79` — "// returning 0 memories on `true`, `123`, or `"text"` would let an"
- `packages/import-gemini/src/parser.test.ts:80` — "// automation pipeline treat an obviously broken invocation as healthy."
- `packages/import-gemini/src/parser.ts:80` — "// File-backed adapter contract: `runImportCommand` passes `undefined` when"
- `packages/import-gemini/src/parser.ts:81` — "// `--file` is omitted. Gemini is a file-only importer (Takeout doesn't"
- `packages/import-gemini/src/parser.ts:82` — "// expose an API), so a missing payload MUST surface as a user-facing"
- `packages/import-gemini/src/parser.ts:83` — "// error rather than silently succeeding with 0 memories. Cursor review"
- `packages/import-gemini/src/parser.ts:84` — "// on PR #600 flagged the silent-success path."
- `packages/import-gemini/src/parser.ts:113` — "// Codex review on PR #600: pointing --file at a random JSON object"
- `packages/import-gemini/src/parser.ts:114` — "// (e.g. a config file) used to report a successful 0-memory import."
- `packages/import-gemini/src/parser.ts:115` — "// We now throw a user-facing error when no known wrapper key was"
- `packages/import-gemini/src/parser.ts:116` — "// present. This differs from strict mode because the "array or"
- `packages/import-gemini/src/parser.ts:117` — "// object" shape check already passed — we just didn't find anything"
- `packages/import-gemini/src/parser.ts:118` — "// that looked like a Gemini export inside the object."
- `packages/import-gemini/src/parser.ts:129` — "// Codex review on PR #600 — primitive payloads (numbers, booleans,"
- `packages/import-gemini/src/parser.ts:130` — "// strings, etc.) must always throw, regardless of strict mode. Silently"
- `packages/import-gemini/src/parser.ts:131` — "// returning a 0-memory success on a JSON primitive (e.g. `true`,"
- `packages/import-gemini/src/parser.ts:132` — "// `"text"`, `123`) hides operator input mistakes and makes automation"
- `packages/import-gemini/src/parser.ts:133` — "// treat a broken import as healthy. Report the actual received value —"
- `packages/import-gemini/src/parser.ts:134` — "// `typeof null === "object"` is the JS trap CLAUDE.md rule 18 calls"
- `packages/import-gemini/src/parser.ts:135` — "// out. Using describeType() sidesteps the "received object" message"
- `packages/import-gemini/src/parser.ts:136` — "// for null inputs."
- `packages/import-mem0/src/parser.ts:13` — "// Non-object entries are dropped in non-strict mode (CLAUDE.md rule 51"
- `packages/import-mem0/src/parser.ts:14` — "// applies only to user-facing CLI inputs; parser leniency here protects"
- `packages/import-mem0/src/parser.ts:15` — "// against server-side schema drift without crashing the import)."
- `packages/import-weclone/src/index.ts:46` — "// Let unexpected registry failures surface at import time so the public"
- `packages/import-weclone/src/index.ts:47` — "// "import registers the adapter" contract cannot silently become false."
- `packages/import-weclone/src/integration.test.ts:324` — "// Mirrors runBulkImportCliCommand's contract: the CLI reads the file,"
