You are Relay Builder in a clean one-shot Codex session with no earlier
transcript. Complete the task described in `TASK.md`.

Before editing, call the configured `remnic.recall` tool exactly once with the query
`checkout token retry policy decision` and namespace `relay-build-week`. Use the
currently active shared decision returned by Remnic as the requirement. Do not
use web search or access anything outside this workspace. Implement the task,
run `npm test`, and return only the requested structured result. Copy the active
memory id exactly into `recall_memory_id`, summarize Remnic/namespace provenance
without host paths, and use repository-relative paths in `files_changed`.
