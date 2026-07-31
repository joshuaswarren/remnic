# External compiled wikis

External compiled wikis are an on-demand knowledge source, not primary memory. Remnic keeps their pages out of ordinary recall and the default hot-facts collection, even when a search backend returns a relevant wiki hit.

Dedicated wiki collection ids use the `external-wiki-` prefix. The recall assembly path rejects hits from those collections before applying its result limit. `qmdCollection` and `qmdColdCollection` cannot use the reserved prefix.

`wikiMergeIntoRecall` defaults to `false`. Remnic rejects `true` because automatic wiki injection has no recall section or budget accounting in v1.

Use the external-wiki search tool when an agent needs compiled wiki text. Do not copy wiki pages into `memoryDir`; doing so removes the corpus boundary and makes those files primary-memory candidates.
