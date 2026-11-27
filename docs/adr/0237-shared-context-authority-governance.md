# Shared-context items carry a server-derived authority envelope; binding requires exact, validated opt-in and stale or disputed items are marked, never deleted or averaged

Status: accepted

## Context

Multiple agents read and write a shared-context store. Stored data can claim more authority than its origin warrants, timestamps can be silently reinterpreted, and two agents can disagree about the same feedback. Governance must be least-privilege by default, exact at the boundaries, and deterministic in resolution.

## Decision

Authority resolution is least-privilege: unknown origin values remain unknown rather than being promoted to user authority; import/connector identity outranks turn role; binding requires an explicit allowBinding flag read ONCE (a getter/Proxy returning different values on validation vs decision reads is the attack), and a truthy string/number must not enable binding. Absent and present-but-invalid authority both resolve to informational — the least-privileged class — with EXACT value matching (no trim, no case-fold). Stored data already carrying an unpopt-in "binding" token downgrades rather than throws, to the highest class not requiring opt-in.

Write origin is derived by the server from the authenticated access surface, not from client-supplied agentId; the client producer label survives for display/grouping only and is never audit metadata. Every content line in the authority fence gets a `>` marker (the escape rule).

Envelope timestamps are validated strictly: blank is missing_at; anything not calendar-valid ISO-8601 is invalid_at — no permissive Date.parse, no whitespace-padded acceptance. Instant validation uses a linear regex (no nested quantifiers).

Expiry: expired items never enter the working set; superseded items are marked while they circulate (mark, not delete). Feedback refs are claim keys: two agents ruling differently on the same ref surface as disputed, never silently averaged. Every synthesized claim must cite at least one item the run actually had (lint tripwire). Supersession-chain resolution is deterministic — fork resolution keeps the smallest successor id — and curation-lint output is deterministic with a tertiary comparator key so input order cannot decide results. Slug trimming avoids ReDoS-prone anchored quantifiers.

## Consequences

Exact matching rejects benignly padded legacy values; strict timestamp validation may reject data older emitters considered valid; disputed feedback surfaces rather than resolving silently.

## Origin comments

- `packages/remnic-core/src/security/origin-authority.ts:1` — "The least-privilege default is intentional"
- `packages/remnic-core/src/security/origin-authority.ts:22` — "Unknown values remain unknown instead of being promoted to user authority."
- `packages/remnic-core/src/security/origin-authority.ts:46` — "Classify a write origin. Import and connector identity outrank turn role."
- `packages/remnic-core/src/security/origin-authority.ts:77` — "Every content line gets a > marker. This is also the escape rule"
- `packages/remnic-core/src/shared-context/authority-precedence.test.ts:36` — "Flag on proves these stay informational because of the exact-value check"
- `packages/remnic-core/src/shared-context/authority-precedence.test.ts:37` — "check, not because binding was denied."
- `packages/remnic-core/src/shared-context/authority-precedence.test.ts:108` — "Review round 2: the flag was read twice — once to validate, once to decide."
- `packages/remnic-core/src/shared-context/authority-precedence.test.ts:109` — "A getter that changes between those reads is the whole attack."
- `packages/remnic-core/src/shared-context/authority-precedence.ts:1` — "Shared-item authority precedence (issue #1957). Resolution is least-privilege; binding requires explicit allowBinding flag."
- `packages/remnic-core/src/shared-context/authority-precedence.ts:36` — "Read the security switch ONCE. A getter (or a Proxy) can return undefined"
- `packages/remnic-core/src/shared-context/authority-precedence.ts:37` — "during validation and true at the decision, which would let binding"
- `packages/remnic-core/src/shared-context/authority-precedence.ts:38` — "through without a validated opt-in."
- `packages/remnic-core/src/shared-context/authority-precedence.ts:41` — "The flag is the security switch, so a truthy string or number must"
- `packages/remnic-core/src/shared-context/authority-precedence.ts:42` — "not enable binding: reject it instead of coercing."
- `packages/remnic-core/src/shared-context/authority-precedence.ts:48` — "Absent (missing key, undefined, null) and present-but-invalid both land"
- `packages/remnic-core/src/shared-context/authority-precedence.ts:49` — "on informational — the least-privileged class — so an unmarked or"
- `packages/remnic-core/src/shared-context/authority-precedence.ts:50` — "malformed legacy item can never be treated as binding. Validate the"
- `packages/remnic-core/src/shared-context/authority-precedence.ts:51` — "exact value: no trim, no case-fold, because \" binding\" and \"BINDING\""
- `packages/remnic-core/src/shared-context/authority-precedence.ts:52` — "are unrecognized data, not normalized matches for a known class."
- `packages/remnic-core/src/shared-context/authority-precedence.ts:56` — "Downgrade rather than throw: a legacy item already carrying \"binding\""
- `packages/remnic-core/src/shared-context/authority-precedence.ts:57` — "is stored data, not a caller bug, so it resolves to the highest class"
- `packages/remnic-core/src/shared-context/authority-precedence.ts:58` — "that does not require the explicit opt-in."
- `packages/remnic-core/src/shared-context/curation-lint.test.ts:138` — "Review: two claims sharing a claimId AND a reason still differ by their"
- `packages/remnic-core/src/shared-context/curation-lint.test.ts:139` — "unknownIds, so a comparator returning 0 there let input order decide the"
- `packages/remnic-core/src/shared-context/curation-lint.test.ts:140` — "output — the contract says the result is deterministic."
- `packages/remnic-core/src/shared-context/curation-lint.ts:58` — "Duplicate claim ids are linted independently, so two findings can share"
- `packages/remnic-core/src/shared-context/curation-lint.ts:59` — "both keys above and still differ. Without this tertiary key the result"
- `packages/remnic-core/src/shared-context/curation-lint.ts:60` — "would depend on upstream iteration order, which the deterministic-output"
- `packages/remnic-core/src/shared-context/curation-lint.ts:61` — "contract forbids."
- `packages/remnic-core/src/shared-context/envelope-at.test.ts:21` — "Regression (issue #1957 review round 3): permissive Date.parse accepted and silently reinterpreted values."
- `packages/remnic-core/src/shared-context/envelope-at.test.ts:36` — "A whitespace-padded timestamp is not the value the caller supplied."
- `packages/remnic-core/src/shared-context/envelope-at.ts:1` — "Blank is missing_at. Not calendar-valid ISO-8601 is invalid_at; trim() only detects blankness (review round 3)."
- `packages/remnic-core/src/shared-context/envelope-io.ts:1` — "Shared-item envelope wiring (issue #1957, control 1: origin + authority)."
- `packages/remnic-core/src/shared-context/envelope-io.ts:82` — "Reserved governance origin for an authenticated external access write that"
- `packages/remnic-core/src/shared-context/envelope-io.ts:91` — "Producer identity: frontmatter `agent`, on-disk segment, and the"
- `packages/remnic-core/src/shared-context/envelope-io.ts:101` — "Resolve the producer identity and governance origin for a shared-context"
- `packages/remnic-core/src/shared-context/envelope-io.ts:154` — "Validate and compose the envelope for a shared-context write."
- `packages/remnic-core/src/shared-context/envelope-wiring.test.ts:1` — "Regression: shared-item authority envelope wiring (issue #1957, control 1)."
- `packages/remnic-core/src/shared-context/envelope-wiring.test.ts:158` — "Regression (issue #1957 review): the stored token is validated EXACTLY."
- `packages/remnic-core/src/shared-context/envelope-wiring.test.ts:159` — "Trimming first would let `\" binding \"` resolve as binding when the opt-in"
- `packages/remnic-core/src/shared-context/envelope-wiring.test.ts:160` — "is on, and as advisory when it is off — both above informational."
- `packages/remnic-core/src/shared-context/envelope-wiring.test.ts:182` — "The same exactness holds at the write boundary: padded is rejected, not"
- `packages/remnic-core/src/shared-context/envelope-wiring.test.ts:183` — "normalized into a privileged class."
- `packages/remnic-core/src/shared-context/governance-wiring.test.ts:1` — "Regression: #1957 governance controls 2-4 wired into the REAL manager"
- `packages/remnic-core/src/shared-context/governance-wiring.test.ts:36` — "Stored-item shape the write path cannot produce (past expiry), but the"
- `packages/remnic-core/src/shared-context/governance.ts:1` — "Shared-item authority envelope (issue #1957)."
- `packages/remnic-core/src/shared-context/governance.ts:45` — "Read the authority token EXACTLY as supplied or stored. A padded value"
- `packages/remnic-core/src/shared-context/iso-instant.ts:1` — "Strict ISO-8601 instant validation for shared-context envelopes"
- `packages/remnic-core/src/shared-context/iso-instant.ts:15` — "Linear ISO instant. No nested quantifiers."
- `packages/remnic-core/src/shared-context/manager.ts:46` — "Trim leading/trailing dashes without ReDoS-prone anchored quantifiers"
- `packages/remnic-core/src/shared-context/manager.ts:475` — "Feedback inbox path. An explicit `sharedContextDir` keeps the inbox beside"
- `packages/remnic-core/src/shared-context/manager.ts:488` — "Copy a pre-upgrade workspace inbox into the memory-dir inbox once."
- `packages/remnic-core/src/shared-context/manager.ts:733` — "Server-resolved identity of the caller, supplied by the access"
- `packages/remnic-core/src/shared-context/manager.ts:740` — "Server-owned origin token for a write that crosses an external"
- `packages/remnic-core/src/shared-context/manager.ts:891` — "Control 2 (issue #1957): expired items never enter the working set;"
- `packages/remnic-core/src/shared-context/manager.ts:892` — "items another live item supersedes are marked while they circulate."
- `packages/remnic-core/src/shared-context/manager.ts:1004` — "Control 3 (issue #1957): feedback refs are claim keys; two agents"
- `packages/remnic-core/src/shared-context/manager.ts:1005` — "ruling differently on the same ref surface as disputed, never silently"
- `packages/remnic-core/src/shared-context/manager.ts:1006` — "averaged. Pairwise scan is bounded by one day's feedback entries."
- `packages/remnic-core/src/shared-context/manager.ts:1129` — "Control 4 (issue #1957): every synthesized claim must cite at least one"
- `packages/remnic-core/src/shared-context/manager.ts:1130` — "item this run actually had. Overlaps are built from sources, so this is"
- `packages/remnic-core/src/shared-context/manager.ts:1131` — "a tripwire — it fires only if a synthesized section stops citing."
- `packages/remnic-core/src/shared-context/staleness.ts:1` — "Shared-item staleness (issue #1957)."
- `packages/remnic-core/src/shared-context/supersession-chain.ts:1` — "Supersession chain resolution for shared-context curation (issue #1957)."
- `packages/remnic-core/src/shared-context/supersession-chain.ts:26` — "Resolve the live head of the supersession chain that starts at `startId`."
- `packages/remnic-core/src/shared-context/supersession-chain.ts:66` — "Fork resolution: keep the smallest successor id for determinism."
- `packages/remnic-core/src/shared-context/write-origin.test.ts:1` — "Regression: shared-context write origin is server-derived (issue #1957"
- `packages/remnic-core/src/shared-context/write-origin.test.ts:106` — "The default request-identity path: bearer-authenticated surface, no"
- `packages/remnic-core/src/shared-context/write-origin.test.ts:107` — "configured principal, no adapter identity — principal resolves to"
- `packages/remnic-core/src/shared-context/write-origin.test.ts:108` — "undefined. The client's `agentId` must not become audit metadata."
- `packages/remnic-core/src/shared-context/write-origin.test.ts:118` — "The producer label survives for grouping/display — it is not audit"
- `packages/remnic-core/src/shared-context/write-origin.test.ts:119` — "metadata and collapsing it would erase multi-agent overlaps."
- `packages/remnic-core/src/shared-context/write-output-controls.test.ts:1` — "Regression: governed write-output envelope controls exposed on BOTH"
- `packages/remnic-core/src/shared-context/write-output-controls.ts:1` — "Canonical client-input parse for shared-context write-output envelope"
