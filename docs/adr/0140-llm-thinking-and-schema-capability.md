# Provider-specific thinking and schema capabilities are learned, TTL-bounded, and fail open - never sent to a backend that has not proven support

Status: accepted

## Context
Thinking-capable models (Qwen 3.5, Gemma 4, DeepSeek) default to thinking-on, burning 1,700-2,000 reasoning tokens per extraction until they exceed the client timeout and retry forever. The obvious lever, chat_template_kwargs with enable_thinking false, is a llama.cpp / LM Studio / vLLM extension - strict OpenAI-compatible backends reject unknown fields with 400, which trips the 400-cooldown path and can effectively disable local extraction (Codex P1, PR #550). Ollama silently drops that kwarg entirely; only reasoning_effort maps to think-off (issue #1996, verified against Ollama 0.32.0 source). Separately, providers may accept structured output in principle but reject draft-7 nullable type unions with a schema-fragment-quoting 400 that never names response_format (MiniMax-M3.1-Flash production signature, 2026-11-05), re-sending the identical payload until the breaker opens.

## Decision
(1) chat_template_kwargs is sent ONLY when the backend has been positively identified as thinking-capable; 'generic' means do not send (fail open). (2) Suppression is applied to operations that benefit from terse structured output; consolidation on the main client keeps thinking enabled for entity resolution and dedup; fast-tier callers can force suppression per request. (3) For Ollama, disable thinking via reasoning_effort (default 'none'); an empty value disables injection (pre-#1996 behavior). (4) A schema-quoting 400 that never names response_format degrades to the pre-schema request shape and the rejection is remembered. (5) Learned native-schema decisions persist through a registry, honor a registry TTL (an expired entry is re-probed, never honored forever; the in-memory set serves only registry-less clients), and a stale in-flight success that settles last must NOT flip a CURRENT 'none' decision back - otherwise later requests re-send the rejected schema. (6) Gateway-style schema rejections degrade without extending the current attempt's deadline. (7) A replacement model-registry record must not erase a learned structuredOutput shaping, but an expired decision is dropped so the re-probe stays due.

## Consequences
Fail-open means thinking-capable but unidentified backends run with reasoning tokens on until detected; schema fallback loses structured-output guarantees for affected providers; TTL re-probing costs occasional extra requests.

## Origin comments
- `packages/remnic-core/src/local-llm-json-schema-fallback.test.ts:319` - "// Production signature (2026-11-05, MiniMax-M3.1-Flash via local proxy): a"
- `packages/remnic-core/src/local-llm-json-schema-fallback.test.ts:320` - "// 400 \"invalid params — Mismatch type string with value array\" quoting a"
- `packages/remnic-core/src/local-llm-json-schema-fallback.test.ts:321` - "// schema fragment like `\"episodeTitle\": {\"type\": [\"string\",\"null\"]}`. The"
- `packages/remnic-core/src/local-llm-json-schema-fallback.test.ts:322` - "// provider accepts structured output in principle but its strict parser"
- `packages/remnic-core/src/local-llm-json-schema-fallback.test.ts:323` - "// rejects our draft-7 nullable type unions. Unlike capability rejections"
- `packages/remnic-core/src/local-llm-json-schema-fallback.test.ts:324` - "// these errors never name response_format, so nothing stripped the format,"
- `packages/remnic-core/src/local-llm-json-schema-fallback.test.ts:325` - "// every drain attempt re-sent the identical payload, and the 400 breaker"
- `packages/remnic-core/src/local-llm-json-schema-fallback.test.ts:326` - "// opened. The zod draft-7 schema legitimately contains `type` arrays"
- `packages/remnic-core/src/local-llm-json-schema-fallback.test.ts:327` - "// (nullable fields), so the provider dialect, not our request, is the"
- `packages/remnic-core/src/local-llm-json-schema-fallback.test.ts:328` - "// constraint: degrade to the pre-schema request shape and remember it."
- `packages/remnic-core/src/local-llm-json-schema-fallback.test.ts:454` - "// Age the entry past the 7-day registry TTL, as a long-lived deployment"
- `packages/remnic-core/src/local-llm-json-schema-fallback.test.ts:455` - "// would: the learned rejection must not be honored forever."
- `packages/remnic-core/src/local-llm-json-schema-fallback.test.ts:511` - "// Age the learned decision past the registry TTL exactly as a long-lived"
- `packages/remnic-core/src/local-llm-json-schema-fallback.test.ts:512` - "// deployment would."
- `packages/remnic-core/src/local-llm-json-schema-fallback.test.ts:559` - "// The older in-flight success settles last: it must not flip the"
- `packages/remnic-core/src/local-llm-json-schema-fallback.test.ts:560` - "// decision back, or later requests re-send the rejected schema."
- `packages/remnic-core/src/local-llm-native-schema.ts:39` - "// Registry-backed decisions honor the registry TTL: an expired entry is"
- `packages/remnic-core/src/local-llm-native-schema.ts:40` - "// re-probed instead of being honored forever. The in-memory set only"
- `packages/remnic-core/src/local-llm-native-schema.ts:41` - "// serves clients without a registry."
- `packages/remnic-core/src/local-llm-native-schema.ts:63` - "/** A schema-carrying 200: persist the native capability once. A CURRENT * \"none\" stands — that success is stale in-flig"
- `packages/remnic-core/src/local-llm-thinking.test.ts:238` - "// Regression for Codex P1 on PR #550: `chat_template_kwargs` is a"
- `packages/remnic-core/src/local-llm-thinking.test.ts:239` - "// llama.cpp / LM-Studio / vLLM extension. Strict OpenAI-compat"
- `packages/remnic-core/src/local-llm-thinking.test.ts:240` - "// backends reject unknown fields with 400, which trips the"
- `packages/remnic-core/src/local-llm-thinking.test.ts:241` - "// localLlm400Trip cooldown. `generic` means \"backend didn't"
- `packages/remnic-core/src/local-llm-thinking.test.ts:242` - "// positively identify as thinking-capable\" — do not send."
- `packages/remnic-core/src/local-llm.ts:121` - "/** * Backends known to honor `chat_template_kwargs: { enable_thinking: false }` * on OpenAI-compatible `/v1/chat/comple"
- `packages/remnic-core/src/local-llm.ts:905` - "// Suppress thinking/reasoning for operations that benefit from terse,"
- `packages/remnic-core/src/local-llm.ts:906` - "// structured output. Thinking-capable models (Qwen 3.5, Gemma 4,"
- `packages/remnic-core/src/local-llm.ts:907` - "// DeepSeek) default to thinking-on via their chat template; sending"
- `packages/remnic-core/src/local-llm.ts:908` - "// `chat_template_kwargs: { enable_thinking: false }` tells the template"
- `packages/remnic-core/src/local-llm.ts:909` - "// to skip reasoning tokens. Consolidation operations on the main client"
- `packages/remnic-core/src/local-llm.ts:910` - "// intentionally keep thinking enabled so entity resolution and"
- `packages/remnic-core/src/local-llm.ts:911` - "// deduplication can use the model's reasoning path. Fast-tier callers can"
- `packages/remnic-core/src/local-llm.ts:912` - "// still force suppression per request to preserve their low-latency"
- `packages/remnic-core/src/local-llm.ts:913` - "// contract."
- `packages/remnic-core/src/local-llm.ts:914` - "//"
- `packages/remnic-core/src/local-llm.ts:916` - "// Codex P1 on PR #550): `chat_template_kwargs` is an LM Studio /"
- `packages/remnic-core/src/local-llm.ts:917` - "// vLLM / llama.cpp extension, not part of standard OpenAI chat"
- `packages/remnic-core/src/local-llm.ts:918` - "// completions. Strict OpenAI-compatible backends reject"
- `packages/remnic-core/src/local-llm.ts:919` - "// unknown fields with 400, which trips the 400-cooldown path and"
- `packages/remnic-core/src/local-llm.ts:920` - "// can effectively disable local extraction. Fail open when the"
- `packages/remnic-core/src/local-llm.ts:921` - "// backend hasn't been positively identified as thinking-capable."
- `packages/remnic-core/src/local-llm.ts:933` - "// Ollama's /v1 endpoint silently drops `chat_template_kwargs` AND"
- `packages/remnic-core/src/local-llm.ts:934` - "// `enable_thinking` — the ONLY field it maps to think-off is"
- `packages/remnic-core/src/local-llm.ts:935` - "// `reasoning_effort` (\"none\" → ThinkValue{false} in openai.go;"
- `packages/remnic-core/src/local-llm.ts:936` - "// verified against Ollama 0.32.0 source and live probes,"
- `packages/remnic-core/src/local-llm.ts:937` - "// issue #1996). Without this, thinking-capable models (Gemma 4,"
- `packages/remnic-core/src/local-llm.ts:938` - "// Qwen 3.5+) burn 1,700-2,000 reasoning tokens per extraction on"
- `packages/remnic-core/src/local-llm.ts:939` - "// Ollama, exceed the client timeout, and retry forever. The effort"
- `packages/remnic-core/src/local-llm.ts:940` - "// is configurable via `localLlmReasoningEffort` (default \"none\");"
- `packages/remnic-core/src/local-llm.ts:941` - "// an empty value disables injection (pre-#1996 behavior)."
- `packages/remnic-core/src/local-llm.ts:1017` - "// Match gateway degradation without extending this attempt's deadline."
- `packages/remnic-core/src/model-registry.ts:198` - "// Reachable only with a missing or expired cached record, so any"
- `packages/remnic-core/src/model-registry.ts:199` - "// learned structuredOutput is stale here — leave it unset and let"
- `packages/remnic-core/src/model-registry.ts:200` - "// getStructuredOutput's freshness rules drive the re-probe."
- `packages/remnic-core/src/model-registry.ts:225` - "// A replacement record (e.g. fresh LM Studio detection) must not erase a"
- `packages/remnic-core/src/model-registry.ts:226` - "// learned structuredOutput shaping — but an EXPIRED decision must not be"
- `packages/remnic-core/src/model-registry.ts:227` - "// renewed either: drop it so the re-probe stays due."
