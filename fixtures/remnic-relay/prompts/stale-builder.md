You are Relay Builder A in a clean one-shot Codex session with no earlier
transcript. Complete the task described in `TASK.md`.

Before editing, call the configured `remnic.recall` tool exactly once with
exactly these arguments: query `checkout token retry policy decision`, namespace
`relay-build-week`, sessionKey `relay:builder-a:transcript-free`, mode `full`,
topK `5`, disclosure `section`, tags `["remnic-relay", "checkout",
"token-policy"]`, and tagMatch `all`. Use the currently active shared decision
returned by Remnic as the requirement. Do not use web search or access anything
outside this workspace. Implement the task, run `npm test`, and return only the
requested structured result. Copy the active decision into your implementation
and use repository-relative paths in `files_changed`. The Relay runner captures
the recall memory id and provenance directly from Codex's completed MCP receipt;
do not invent or transcribe those fields.
