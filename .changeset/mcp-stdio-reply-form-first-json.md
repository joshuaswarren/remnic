---
"@remnic/core": patch
---

The MCP stdio server now picks its reply form (newline or Content-Length) from the first frame that holds valid JSON. A refused or unparsable first frame no longer fixes the reply form for the whole connection. It still gets its own error reply in the form it arrived in. The frame reader also skips blank lines that arrive in the same read as a Content-Length header block, and no longer keeps the old buffer allocation alive after it consumes the last frame.

Stability: stable
