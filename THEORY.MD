# Theory: Legacy mapping paths must stay inside the dataset root

## Problem

Legacy discovery already rejects a symlink dataset dir, a symlink ancestor,
and any symlink inside the dataset tree. MemoryAgentBench still reads
`entity2id.json` from sibling paths under the datasets root:

- `processed_data/Recsys_Redial/entity2id.json`
- `Recsys_Redial/entity2id.json`

Those siblings sit next to `memoryagentbench`, not inside it. A tree walk of
the dataset dir never sees them. `lstat` on the nested file follows an
intermediate directory symlink, so an external mapping looks like a local
regular file. The runner then reads that file.

## Operating Theory

Two consumers share the same candidate list: the downloaded-marker check and
the ReDial mapping loader. Every candidate must pass the same two checks,
including the loose `entity2id.json` under the dataset dir:

1. No-follow scan of each path component from the datasets root to the file
2. Realpath containment under that same root

A sibling `processed_data` or `Recsys_Redial` symlink then fails. A real
directory tree under the datasets root still passes.

The dataset-tree walk stays. It covers unused in-tree links. It does not
cover siblings. The mapping-candidate check covers siblings.

## Strategy

Keep the candidate list. Change only the file check in both consumers. Do
not invent a second discovery root. Do not follow a mapping path that left
the datasets root.

## Key Discoveries

`isRegularFileNoFollow` only `lstat`s the final component. Intermediate
directory symlinks are followed before that call.

`datasetTreeHasSymlink` walks `legacyRoot/memoryagentbench`. Sibling mapping
dirs live on `legacyRoot` itself.

A real `legacyRoot/processed_data/Recsys_Redial/entity2id.json` is valid
layout. The guard must reject the symlink case without rejecting that layout.

Closing discovery alone is not enough. An explicit `--dataset-dir` still
reaches the runner, which used `access`/`readFile` and followed the same
sibling symlink.

## Open Questions

None for this hole. Further review rounds on hypothetical mutations of the
path walk should be declined under the review-round cap.
