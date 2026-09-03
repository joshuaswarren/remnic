---
"@remnic/core": patch
"@remnic/bench": patch
"@remnic/cli": patch
---

Stability: stable

Harden the H5 security surfaces (issue #3078):

- The `response-control-directive` injection-screen rule now requires a corroborating signal (an opaque marker/URL, verbatim control, cross-turn persistence, or an agent-directed subject) alongside the directive shape, so ordinary prose such as "The API response must include a Content-Type header" is no longer quarantined. Measured against the frozen H5 corpora: the quarantine set is byte-identical (1600/1600 attack payloads, 0/400 benign twins, both profiles).
- `audit-memory` screens with the deployment's configured profile, resolved through the shared security capability plan, so a `quarantine`/`layered` deployment retro-quarantines a memory its write path would have quarantined. Deployments with the screen disabled keep the previous `default` weighting.
- The H5 utility contract binds to dataset CONTENTS (a per-file sha256 fold) rather than dataset directory paths, refusing checkpoint reuse when a frozen dataset is edited in place.
- Non-generic OpenAI-compatible request fields (`reasoning_effort`, `chat_template_kwargs`) are gated by endpoint backend AND model family, so a strict server (LM Studio, api.openai.com) receives the generic contract instead of failing every request with HTTP 400.
- An adaptive-online run that recorded a `--limit` is reported non-estimable, so a complete-looking smoke artifact is labeled honestly.
