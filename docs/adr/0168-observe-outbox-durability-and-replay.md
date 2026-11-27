# Observe captures survive daemon outages through a durable outbox that replays under one identity per logical observe

Status: accepted

## Context
Observe payloads carry raw tool output private to the owner's account and can be megabytes. The daemon can be down, refusing work, or swapped mid-session; the outbox file is shared per machine; and a response lost after server-side processing must not cause double ingestion. A deterministic server error must not be able to pin the queue forever.

## Decision
- Classify every send outcome before reacting. 503 and 429 are capacity admission and write-quota backpressure: the capture never executed, a keyed retry is safe, and they do not count against failure limits. 401/403 park the queue with an actionable credentials message. Any other HTTP answer is a semantic rejection no retry can fix — except an unrecognized 5xx, which is treated as retry-ambiguous because it is far more often a transient internal error than a verdict on the payload. Unknown failure shapes are ambiguous too: the request may have been processed, and the stable idempotency key makes a bounded retry safe.
- Ambiguous failures accrue a persisted per-entry failure count. A daemon that deterministically fails the same capture must fall out of the FIFO at the cap with a visible reason instead of pinning it.
- One replay identity per logical observe: the live attempt, any retry of it, and a later outbox replay all send the same idempotency key so the daemon can dedupe a lost response. Suppression of live capture only skips hashes a drain on this daemon would deliver; an entry bound to another destination never suppresses capture here, and an entry already durably queued is never re-sent live under a fresh request identity.
- Dedupe records belong to the entry's own session: hashes and replay keys embed the entry's sessionKey and are recorded in that session's state. A drain running under another session must not file them where they can never match; a writer session that is not live has no in-memory state to teach and nothing is recorded.
- Entries carry their destination. A drain delivers only entries bound to the draining daemon; omitting the destination makes every entry eligible. Switching daemon URLs must neither replay the first daemon's conversations to the second nor suppress the new daemon's live captures.
- Bound oversized raw bodies before the first send. The live body, the persisted outbox entry, and its later replay must stay identical, because the idempotency key hashes the exact body. The persisted representation is bounded by count and re-serialization — a count bound is not a byte bound — while the replay identity (hashes and nonce) survives.
- The outbox file is written by atomic replace with fsync of both the temp file and the directory, so a crash or power loss cannot commit the rename ahead of the data. The file is created 0600 and the rename keeps that mode on every rewrite; new parent directories are private from creation, while a pre-existing parent keeps its mode — the outbox never chmods a shared parent it did not create. A looser file is tightened by the next write's 0600 temp replace; an unreadable file fails closed rather than being repaired into a silent empty.
- On refresh, record the file signature before reading, so a write landing mid-read is seen by the next refresh. An existing but unreadable file is not an empty queue: keep the last known entries, force a re-read next time, and let the caller decide. Only this module writes the file, so parse results lacking replayable shape (message and hash arrays, identity fields) are rejected as corrupt lines and skipped.
- The drain stops on the first 401/403 and reports why, from the last send. Entries keep their original writer's principal; the draining process's principal is only a fallback for pre-field entries. Backoff falls back to the default on a NaN or negative ratio, is clamped after jitter so a sleep never exceeds the documented cap, and runs on an unref'd timer so a background drain cannot keep the host process alive.
- Capacity backpressure or ambiguous failure queues turns durably for replay; successful contact triggers the drain in the background, where it can neither delay the current hook nor fail the delivered turn. A lock timeout or write failure must not lose a turn silently.

## Consequences
Delivery is effectively at-least-once and depends on the daemon honouring the idempotency key. Poisoned entries drop at the failure cap, and hostile or shared filesystem layouts fail closed rather than silently emptying the queue.

## Origin comments
- `packages/plugin-pi/src/index.ts:830` — "// Suppress only hashes a drain on THIS daemon would deliver — an entry bound"
- `packages/plugin-pi/src/index.ts:831` — "// to another destination never reaches this daemon and must not skip capture here (#3504 review)."
- `packages/plugin-pi/src/index.ts:838` — "// Already durably queued for replay — never re-send it live under a fresh"
- `packages/plugin-pi/src/index.ts:839` — "// (different) request identity, or the daemon would ingest it twice."
- `packages/plugin-pi/src/index.ts:846` — "// Bound oversized raw bodies BEFORE the first send (#3381 item 11): the"
- `packages/plugin-pi/src/index.ts:847` — "// daemon dedupes on an idempotency key hashed over the exact body, so the"
- `packages/plugin-pi/src/index.ts:848` — "// live body, the persisted outbox entry and its later replay must stay"
- `packages/plugin-pi/src/index.ts:849` — "// identical or a lost-response replay ingests twice."
- `packages/plugin-pi/src/index.ts:863` — "// One replay identity per logical observe: the live attempt, any retry of it and a"
- `packages/plugin-pi/src/index.ts:864` — "// later outbox replay all send the same key, so the daemon can dedupe a lost response."
- `packages/plugin-pi/src/index.ts:878` — "// Successful contact is the drain trigger: replay anything queued while the"
- `packages/plugin-pi/src/index.ts:879` — "// daemon was refusing work. It runs in the background with its own error"
- `packages/plugin-pi/src/index.ts:880` — "// handling, so it can neither delay this hook nor turn a delivered live turn"
- `packages/plugin-pi/src/index.ts:881` — "// into a failed (and re-queued) one."
- `packages/plugin-pi/src/index.ts:894` — "// Capacity backpressure or ambiguous failure: the turns are not lost —"
- `packages/plugin-pi/src/index.ts:895` — "// queue them durably for replay on the next successful contact."
- `packages/plugin-pi/src/index.ts:902` — "// A lock timeout or write failure must not lose the turn silently."
- `packages/plugin-pi/src/observe-flow.ts:89` — "// Entries enqueued for a different daemon stay queued for it (#3381)."
- `packages/plugin-pi/src/observe-flow.ts:93` — "// Why the drain stopped, from the last send. The drain stops on the first"
- `packages/plugin-pi/src/observe-flow.ts:94` — "// 401/403 and already tells the user to fix the credentials (#3381)."
- `packages/plugin-pi/src/observe-flow.ts:101` — "// The entry keeps its original writer's principal; this drainer's own"
- `packages/plugin-pi/src/observe-flow.ts:102` — "// config.principal is only the fallback for pre-field entries."
- `packages/plugin-pi/src/observe-flow.ts:116` — "// Delivered: remember identity so later turns and the shutdown replay skip"
- `packages/plugin-pi/src/observe-flow.ts:117` — "// these. The hashes and replay keys embed the entry's OWN sessionKey, so"
- `packages/plugin-pi/src/observe-flow.ts:118` — "// they are recorded in that session's state (#3381): a drain running under"
- `packages/plugin-pi/src/observe-flow.ts:119` — "// another session must not file them in its own set, where they can never"
- `packages/plugin-pi/src/observe-flow.ts:120` — "// match, while the writer's shutdown resends the same turns under a new"
- `packages/plugin-pi/src/observe-flow.ts:121` — "// nonce. A writer session that is not live has no in-memory state to teach;"
- `packages/plugin-pi/src/observe-flow.ts:122` — "// its persisted hashes cannot be written from here, so nothing is recorded."
- `packages/plugin-pi/src/observe-flow.ts:135` — "// Entries bound to another daemon are pending for IT, not saturation here."
- `packages/plugin-pi/src/outbox.test.ts:221` — "#3381: an unrecognized 5xx is ambiguous, not a verdict on the payload; the"
- `packages/plugin-pi/src/outbox.test.ts:222` — "per-entry failure cap is what drops a deterministic 5xx like this one."
- `packages/plugin-pi/src/outbox.test.ts:227` — "Unknown failures are ambiguous: bounded retry with a stable idempotency key is safe."
- `packages/plugin-pi/src/outbox.test.ts:540` — "Entries carry rawContent of tool results - private to the owner's account."
- `packages/plugin-pi/src/outbox.test.ts:553` — "observeOutboxPath may point into a shared directory; the outbox must not"
- `packages/plugin-pi/src/outbox.test.ts:554` — "chmod a parent it did not create (Codex P2 on #3503)."
- `packages/plugin-pi/src/outbox.test.ts:559` — "#3381 item 4: an internal_error answer is transient far more often than it"
- `packages/plugin-pi/src/outbox.test.ts:560` — "is semantic; classify it retry-ambiguous and cap each entry's failures so a"
- `packages/plugin-pi/src/outbox.test.ts:561` — "deterministic 500 still falls out of the FIFO instead of pinning it."
- `packages/plugin-pi/src/outbox.test.ts:583` — "#3381 item 6: the outbox file is shared per machine; a pane repointed at a"
- `packages/plugin-pi/src/outbox.test.ts:584` — "second daemon must not replay the first daemon's conversations to it."
- `packages/plugin-pi/src/outbox.test.ts:606` — "The DrainOptions contract: omitting destination makes every entry"
- `packages/plugin-pi/src/outbox.test.ts:607` — "eligible, same as before the field existed (coderabbit on #3504)."
- `packages/plugin-pi/src/outbox.test.ts:623` — "#3381 item 11: rawContent is the original Pi message and can be megabytes;"
- `packages/plugin-pi/src/outbox.test.ts:624` — "a 200-entry bound is not a byte bound, so the persisted representation is"
- `packages/plugin-pi/src/outbox.test.ts:625` — "bounded while the replay identity (hashes + nonce) survives."
- `packages/plugin-pi/src/outbox.test.ts:648` — "#3504 CodeRabbit: switching daemon URLs with a foreign entry queued must not"
- `packages/plugin-pi/src/outbox.test.ts:649` — "suppress the new live capture — that entry is never delivered to this daemon."
- `packages/plugin-pi/src/outbox.ts:75` — "// 503 is server backpressure (capacity admission or not-ready) and 429 a write"
- `packages/plugin-pi/src/outbox.ts:76` — "// quota (observe counts against it); the capture was never executed, so a keyed"
- `packages/plugin-pi/src/outbox.ts:77` — "// retry is safe. 401/403 park the queue. Any other HTTP answer is a semantic"
- `packages/plugin-pi/src/outbox.ts:78` — "// rejection (bad payload, storage-target 400) that no retry can fix — except"
- `packages/plugin-pi/src/outbox.ts:79` — "// an unrecognized 5xx, which is far more often a transient internal_error"
- `packages/plugin-pi/src/outbox.ts:80` — "// than a verdict on the payload (#3381): it is retry-ambiguous, and the"
- `packages/plugin-pi/src/outbox.ts:81` — "// per-entry failure cap is what keeps a deterministic 5xx from pinning the FIFO."
- `packages/plugin-pi/src/outbox.ts:89` — "Unknown failure shapes are treated as ambiguous: the request may have been"
- `packages/plugin-pi/src/outbox.ts:90` — "processed, and the stable idempotency key makes a bounded retry safe."
- `packages/plugin-pi/src/outbox.ts:165` — "SAFETY: JSON.parse produced a non-null, non-array value; this class is the"
- `packages/plugin-pi/src/outbox.ts:166` — "only writer of the outbox file, and the checks below reject every shape it"
- `packages/plugin-pi/src/outbox.ts:167` — "cannot re-serialize and replay (messages/messageHashes arrays, identity"
- `packages/plugin-pi/src/outbox.ts:168` — "fields present). Anything else is treated as a corrupt line and skipped."
- `packages/plugin-pi/src/outbox.ts:226` — "Recorded before the read: a write that lands mid-read changes the signature,"
- `packages/plugin-pi/src/outbox.ts:227` — "so the next refresh sees it and re-reads."
- `packages/plugin-pi/src/outbox.ts:233` — "An existing but unreadable file is NOT an empty queue: the next write would replace it"
- `packages/plugin-pi/src/outbox.ts:234` — "and drop every queued capture. Keep the last known entries, force a re-read next time,"
- `packages/plugin-pi/src/outbox.ts:235` — "and let the caller decide (writes fail closed, read-only views keep what they knew)."
- `packages/plugin-pi/src/outbox.ts:258` — "Atomic replace with fsync of the temp file and the directory, so an OS crash or"
- `packages/plugin-pi/src/outbox.ts:259` — "power loss cannot commit the rename ahead of the data and leave a short queue."
- `packages/plugin-pi/src/outbox.ts:260` — "Entries carry raw tool output, so the queue file is owner-only (#3381); the"
- `packages/plugin-pi/src/outbox.ts:261` — "temp file is created 0600 and the rename keeps that mode on every rewrite."
- `packages/plugin-pi/src/outbox.ts:272` — "New parents are private from creation (#3381). A PRE-EXISTING directory keeps"
- `packages/plugin-pi/src/outbox.ts:273` — "its mode: observeOutboxPath may point into a shared directory, and chmod'ing it"
- `packages/plugin-pi/src/outbox.ts:274` — "would remove other users' access to every sibling (Codex P2 on #3503)."
- `packages/plugin-pi/src/outbox.ts:281` — "The FILE needs no chmod: persist() replaces it through a 0600 temp on"
- `packages/plugin-pi/src/outbox.ts:282` — "every write, so a looser file is tightened by the write itself - and"
- `packages/plugin-pi/src/outbox.ts:283` — "an unreadable one keeps failing closed below instead of being repaired"
- `packages/plugin-pi/src/outbox.ts:284` — "into a silent empty."
- `packages/plugin-pi/src/outbox.ts:386` — "A NaN/negative ratio would make the sleep NaN (a hot retry loop); fall back to the default."
- `packages/plugin-pi/src/outbox.ts:392` — "unref: a background drain's backoff must not keep the host process alive."
- `packages/plugin-pi/src/outbox.ts:447` — "Ambiguous failures accrue a persisted per-entry count: a daemon"
- `packages/plugin-pi/src/outbox.ts:448` — "that fails the same capture every time (a deterministic 500) must"
- `packages/plugin-pi/src/outbox.ts:449` — "not pin the FIFO forever, so the entry leaves the queue at the cap"
- `packages/plugin-pi/src/outbox.ts:450` — "with a visible reason (#3381). Capacity refusals are the daemon"
- `packages/plugin-pi/src/outbox.ts:451` — "asking us to come back, so they are not counted."
- `packages/plugin-pi/src/outbox.ts:471` — "Clamp AFTER jitter so the sleep never exceeds the documented cap."
