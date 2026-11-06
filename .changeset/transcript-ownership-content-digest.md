---
"@remnic/core": patch
---

Stability: stable

Replace the metadata-only transcript directory ownership cache with a bounded content-digest parse cache. The old cache served a stale "owner" verdict whenever each JSONL file's size was unchanged, so an equal-size rewrite to foreign or malformed content, or a file that became unreadable, still let appends land in a directory another session had taken over. Every ownership check now reads each file's exact bytes and hashes them itself. It reuses a cached verdict only for a newline-terminated prefix whose bytes hash to the recorded digest, and parses only the bytes after it. Anything else, including rewrites at equal size, prefix edits, truncation, and read errors, falls back to an independent full parse or an occupied verdict. Verdicts are keyed by session and never shared across concurrent callers, only owned prefixes are cached, and the cache is an LRU capped at 4096 entries.

Cost: every append now reads and hashes the session directory's full history, where the size cache skipped the read. On a 115 MB synthetic history a warm sequential append measured about 138 ms against about 37 ms before; concurrent appends measured 4.6x to 7.3x faster in wall time. This does not close the check-then-append window between the ownership check and the write, or the symlink-swap window between the path check and the read.
