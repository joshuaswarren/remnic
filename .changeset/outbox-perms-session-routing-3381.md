---
"@remnic/plugin-pi": patch
"@remnic/core": patch
---

Stability: stable

Two follow-ups from the observe outbox review (#3381):

- Pi observe outbox: the queue that persists full observe messages (including raw tool output) is now private to the owner — the dedicated directory is tightened to 0700 and every write produces a 0600 file. A file or directory left looser by an older version is tightened on the next write; a file that cannot be read still fails the write closed rather than being treated as empty.
- Pi observe outbox: a drain delivering another session's queued entry now records the delivered message hashes and live-replay keys in THAT session's state (resolved by the entry's own sessionKey), instead of filing foreign identities in the drainer's dedup set where they can never match. Entries whose writer session is no longer live record nowhere.
