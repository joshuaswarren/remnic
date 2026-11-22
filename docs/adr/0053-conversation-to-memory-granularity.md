# Chat exports import durable content one-to-one by default and conversations only as opt-in, size-capped summaries

Status: accepted

## Context
Provider exports contain two very different surfaces: durable content the user deliberately kept (saved memories, pinned project docs, prompts they typed) and conversation bodies that mix transient and durable content. Importing conversation bodies verbatim would balloon the store for users with thousands of chats and pollute the extraction pipeline with noise, while dropping them entirely loses real context. Each provider's export also has structural quirks: ChatGPT conversations are trees with abandoned branches, Claude exports carry both a current and a legacy message field and may lack per-turn timestamps, Google Takeout strips assistant responses from Gemini Apps exports, and titles alone can exceed truncation caps.

## Decision
Default imports cover durable surfaces only, one memory per item: ChatGPT saved memories, Claude project docs plus each non-empty `prompt_template`, and every Gemini Apps activity record (its prompt text is first-person intent; Takeout omits assistant responses). Conversation bodies become memories only when the caller opts in with `includeConversations`; each conversation yields exactly one memory that concatenates the user-side turns ("user said X, Y, Z"), never the verbatim transcript. This bounds the import footprint. Gemini has no conversation layer, so `includeConversations` is ignored there.

Content selection for ChatGPT conversations walks the active chain from `current_node` to the root via `parent` links, reversed into chronological order, which excludes branches the user backed out of. If `current_node` is missing, or the chain has a cycle or a dangling parent link, fall back to a deterministic timestamp-sorted walk over all nodes with node id as the stable secondary key — never return a partial tail that silently omits the root.

Claude conversations prefer `chat_messages` and fall back to the legacy `messages` field whenever `chat_messages` is missing OR empty — a length check, not just `??`, because an empty array is non-null but has no content. When per-turn timestamps are absent, take the conversation-level `updated_at`/`created_at`, so exports without message timestamps do not all look newly imported and skew recency-based retrieval.

Truncation invariant: final `content.length` never exceeds `maxChars`. Reserve up to 3 characters for the "..." suffix and truncate the suffix itself when `maxChars < 3`; a title longer than the cap must not push content past it.

For WeChat-style exports, when `selfSender` is omitted it is inferred while skipping senders that match bot/AI hints; hints match whole words (`\b` boundaries) so short tokens cannot false-positive, and inference must work even when the first message is from a bot or every sender matches the heuristics.

## Consequences
Verbatim conversation text never enters the store by default, and downstream extraction scores the summaries it gets. Abandoned ChatGPT branches are dropped by design. Each fallback path (legacy field, conversation-level timestamps, timestamp-sorted walk) is a second code path to maintain, and its output is only as good as the coarsest metadata the export provides.

Note: Merged into this theme to stay within the ten-file limit: the 4 WeClone sender-attribution records — nearest neighbour, decisions about what the user-side content of a conversation is.

## Origin comments
- `packages/import-chatgpt/src/parser.ts:347` — "// Prefer walking the active chain from `current_node` up to the root via"
- `packages/import-chatgpt/src/parser.ts:348` — "// `parent` links, then reverse so we visit in chronological order. This"
- `packages/import-chatgpt/src/parser.ts:349` — "// mirrors how ChatGPT renders the conversation and excludes abandoned"
- `packages/import-chatgpt/src/parser.ts:350` — "// branches the user backed out of. If `current_node` is missing, fall"
- `packages/import-chatgpt/src/parser.ts:351` — "// back to a deterministic traversal of all nodes sorted by create_time"
- `packages/import-chatgpt/src/parser.ts:352` — "// with node id as the stable secondary key."
- `packages/import-chatgpt/src/parser.ts:362` — "// Stable secondary key: node id. Without this, nodes with equal"
- `packages/import-chatgpt/src/parser.ts:363` — "// or missing timestamps order non-deterministically."
- `packages/import-chatgpt/src/parser.ts:404` — "// Cycle — refuse to trust the chain. Fall back to timestamp sort."
- `packages/import-chatgpt/src/parser.ts:410` — "// Broken parent link (dangling reference). Don't return a partial"
- `packages/import-chatgpt/src/parser.ts:411` — "// tail — it would silently omit the root and leave the caller with"
- `packages/import-chatgpt/src/parser.ts:412` — "// an inconsistent view. Fall back to the timestamp-sorted walk."
- `packages/import-chatgpt/src/parser.ts:413` — "// Codex review on PR #595."
- `packages/import-chatgpt/src/transform.test.ts:173` — "// Cursor review on PR #595 — when the title alone is longer than maxChars,"
- `packages/import-chatgpt/src/transform.test.ts:174` — "// the previous truncation logic produced content that exceeded the cap."
- `packages/import-chatgpt/src/transform.ts:5` — "// Two shapes of memory come out of a ChatGPT export:"
- `packages/import-chatgpt/src/transform.ts:6` — "//"
- `packages/import-chatgpt/src/transform.ts:7` — "// 1. Saved memories — first-person facts the user confirmed. 1:1 mapping:"
- `packages/import-chatgpt/src/transform.ts:8` — "// every entry becomes one `ImportedMemory`. This is the default."
- `packages/import-chatgpt/src/transform.ts:9` — "// 2. Conversation summaries — only produced when the caller opts in via"
- `packages/import-chatgpt/src/transform.ts:10` — "// `includeConversations: true`. Each conversation is reduced to a"
- `packages/import-chatgpt/src/transform.ts:11` — "// single "user said X, Y, Z" summary (user-side turns concatenated),"
- `packages/import-chatgpt/src/transform.ts:12` — "// not uploaded verbatim. The rationale is that the conversation"
- `packages/import-chatgpt/src/transform.ts:13` — "// bodies mix transient and durable content, and the extraction"
- `packages/import-chatgpt/src/transform.ts:14` — "// pipeline downstream will score them — but we need SOMETHING"
- `packages/import-chatgpt/src/transform.ts:15` — "// coherent to hand it. One memory per conversation keeps the import"
- `packages/import-chatgpt/src/transform.ts:16` — "// footprint bounded when users have thousands of chats."
- `packages/import-claude/src/parser.test.ts:164` — "// Cursor review on PR #598 — collectHumanTurnsFromConversation must fall"
- `packages/import-claude/src/parser.test.ts:165` — "// back to `messages` when `chat_messages` is an empty array (not just"
- `packages/import-claude/src/parser.test.ts:166` — "// when it's undefined)."
- `packages/import-claude/src/parser.ts:284` — "// Prefer chat_messages when it has entries; fall back to the legacy"
- `packages/import-claude/src/parser.ts:285` — "// `messages` field. `??` alone is insufficient because an empty"
- `packages/import-claude/src/parser.ts:286` — "// `chat_messages` array is non-null but has no content — without the"
- `packages/import-claude/src/parser.ts:287` — "// length check, we would miss turns that only live in the legacy"
- `packages/import-claude/src/parser.ts:288` — "// `messages` array. Cursor review on PR #598."
- `packages/import-claude/src/transform.test.ts:104` — "// Cursor review on PR #598 — when the title alone is longer than"
- `packages/import-claude/src/transform.test.ts:105` — "// maxChars, the previous truncation logic produced content that"
- `packages/import-claude/src/transform.test.ts:106` — "// exceeded the cap."
- `packages/import-claude/src/transform.test.ts:136` — "// Cursor review on PR #598 — even when maxChars is below the suffix"
- `packages/import-claude/src/transform.test.ts:137` — "// length (3), content.length must never exceed maxChars. The earlier"
- `packages/import-claude/src/transform.test.ts:138` — "// fix unconditionally appended "..." which produced 3-char output for"
- `packages/import-claude/src/transform.test.ts:139` — "// maxChars=2."
- `packages/import-claude/src/transform.ts:5` — "// Claude exports contain two distinct memory-worthy surfaces:"
- `packages/import-claude/src/transform.ts:6` — "//"
- `packages/import-claude/src/transform.ts:7` — "// 1. Project docs + `prompt_template` — durable personal context the user"
- `packages/import-claude/src/transform.ts:8` — "// explicitly pinned to a project. These are imported 1:1 by default;"
- `packages/import-claude/src/transform.ts:9` — "// each doc becomes one memory, and each project's prompt_template (if"
- `packages/import-claude/src/transform.ts:10` — "// non-empty) becomes one memory."
- `packages/import-claude/src/transform.ts:11` — "// 2. Conversations — per-conversation summaries, only emitted when the"
- `packages/import-claude/src/transform.ts:12` — "// caller opts in via `includeConversations: true`. The summary"
- `packages/import-claude/src/transform.ts:13` — "// concatenates human-side turns (user messages) so downstream"
- `packages/import-claude/src/transform.ts:14` — "// extraction has coherent content to score. One memory per conversation"
- `packages/import-claude/src/transform.ts:15` — "// keeps the footprint bounded."
- `packages/import-claude/src/transform.ts:150` — "// Reserve up to 3 chars for the "..." suffix, but truncate the suffix"
- `packages/import-claude/src/transform.ts:151` — "// itself when `maxChars` is below 3 so the final content.length is"
- `packages/import-claude/src/transform.ts:152` — "// strictly ≤ maxChars. Cursor reviews on PR #598 flagged both the"
- `packages/import-claude/src/transform.ts:153` — "// long-title case (titleLine alone exceeds maxChars) and the"
- `packages/import-claude/src/transform.ts:154` — "// pathologically small cap (maxChars < suffix.length)."
- `packages/import-claude/src/transform.ts:166` — "// Codex review on PR #598 — when per-turn timestamps are absent, fall"
- `packages/import-claude/src/transform.ts:167` — "// back to the conversation-level `updated_at`/`created_at`. Without"
- `packages/import-claude/src/transform.ts:168` — "// this fallback, exports that omit message-level timestamps lose their"
- `packages/import-claude/src/transform.ts:169` — "// original time metadata entirely, which makes old conversations look"
- `packages/import-claude/src/transform.ts:170` — "// newly imported and skews recency-based retrieval."
- `packages/import-gemini/src/transform.ts:5` — "// Google Takeout only exports the user's prompts — assistant responses are"
- `packages/import-gemini/src/transform.ts:6` — "// omitted by Google. We therefore import every Gemini Apps activity record"
- `packages/import-gemini/src/transform.ts:7` — "// as one memory containing the prompt text. Each prompt is first-person"
- `packages/import-gemini/src/transform.ts:8` — "// intent (what the user asked), which the downstream extraction pipeline"
- `packages/import-gemini/src/transform.ts:9` — "// can score / cluster just like any other memory source."
- `packages/import-gemini/src/transform.ts:10` — "//"
- `packages/import-gemini/src/transform.ts:11` — "// Unlike the ChatGPT and Claude importers, there is no "conversation" layer"
- `packages/import-gemini/src/transform.ts:12` — "// to opt into — Takeout doesn't preserve conversation boundaries for"
- `packages/import-gemini/src/transform.ts:13` — "// Gemini Apps. The `includeConversations` flag is ignored."
- `packages/import-weclone/src/parser.test.ts:360` — "// The first message is from a bot. Inferring `selfSender` from the"
- `packages/import-weclone/src/parser.test.ts:399` — "// Pathological case: every sender matches bot heuristics. We still"
- `packages/import-weclone/src/parser.ts:71` — "/** * Hints used to detect bot/AI senders. Each hint is matched as a whole word * (`\b` boundary) so that short token"
- `packages/import-weclone/src/parser.ts:223` — "// Determine self sender. When caller omits `selfSender`, infer it from"
