---
"@remnic/core": patch
---

Stability: alpha

Replace the metadata-only transcript directory ownership cache with a bounded content-digest parse cache. The old cache served a stale "owner" verdict whenever each JSONL file's size was unchanged, so an equal-size rewrite to foreign or malformed content, or a file that became unreadable, still let appends land in a directory another session had taken over. Every ownership check now reads each file's exact bytes and hashes them itself. It reuses a cached verdict only for a newline-terminated prefix whose bytes hash to the recorded digest, and parses only the bytes after it. Anything else, including rewrites at equal size, prefix edits, truncation, and read errors, falls back to an independent full parse or an occupied verdict. Verdicts are keyed by session and never shared across concurrent callers, only owned prefixes are cached, and the cache is an LRU capped at 4096 entries.
