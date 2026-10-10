# QMD patches

The supported install is commit `93d211f9ef4a869a9aed0d075ca767dda552627f`
(package version still 2.8.3) plus these two patches, in either order:

- `qmd-2.8.3-mcp-cancel.patch` — stop a cancelled `query` between rerank documents
- `qmd-2.8.3-stdio-stdout.patch` — keep JSON-RPC on stdout while llama initializes (#971)

`qmd-2.5.3-mcp-cancel.patch` and `qmd-2.5.3-vec0-repack.patch` apply only to
tag `v2.5.3`. They are the measurement base for the unpartitioned repack bench.
Do not install them. The production repack is upstream's partitioned `qmd cleanup`
on the pinned commit. Install, backup, and rollback steps are in
`docs/qmd-2.8.3.md`.
