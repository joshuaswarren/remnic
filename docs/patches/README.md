# QMD patches

The supported install is commit `93d211f9ef4a869a9aed0d075ca767dda552627f`
(package version still 2.8.3) plus these patches. The first two are the
binary. The third only updates QMD's own tests so they follow that binary.
Apply the test patch after the cancel patch, including on a tree that
already has the other two:

- `qmd-2.8.3-mcp-cancel.patch` — stop a cancelled `query` between rerank documents
- `qmd-2.8.3-stdio-stdout.patch` — keep JSON-RPC on stdout while llama initializes (#971)
- `qmd-2.8.3-rerank-mocks.patch` — `test/llm.test.ts` only. The cancel patch
  scores with `context.rank()` one document at a time. The rerank-dedup test
  and the fewer-active-contexts test mocked `rankAll`, so both threw
  `ctx.rank is not a function`. The dedup test still requires each distinct
  text to be scored once and that score copied onto every file that shared
  it. The context test still requires 20 documents to use exactly two of
  four contexts, with both of those contexts taking work.

`qmd-2.5.3-mcp-cancel.patch` and `qmd-2.5.3-vec0-repack.patch` apply only to
tag `v2.5.3`. They are the measurement base for the unpartitioned repack bench.
Do not install them. The production repack is upstream's partitioned `qmd cleanup`
on the pinned commit. Install, backup, and rollback steps are in
`docs/qmd-2.8.3.md`.
