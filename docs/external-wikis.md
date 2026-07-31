# External compiled wikis

External compiled wikis are an on-demand knowledge source, not primary memory.
Remnic keeps their pages out of ordinary recall and the default hot-facts
collection, even when a search backend returns a relevant wiki hit.

A root is a catalog plus markdown concept pages:

```text
engineering/
├── INDEX.md
└── wiki/
    ├── deployment.md
    └── incident-response.md
```

Configure one or more roots in `remnic.config.json`:

```json
{
  "externalWikis": [
    {
      "id": "engineering",
      "rootDir": "/srv/knowledge/engineering",
      "label": "Engineering knowledge"
    }
  ]
}
```

`rootDir` must be an absolute path or begin with `~/`, and it must not overlap
`memoryDir`. The defaults expect `INDEX.md` and a `wiki/` page directory. A
missing catalog degrades to page-title discovery; one missing root does not
block healthy roots.

Search from the CLI:

```bash
remnic external-wiki search deployment rollback --limit 5
remnic external-wiki search deployment rollback --wiki-id engineering --json
```

Agents can call `remnic.external_wiki_search` (or the legacy
`engram.external_wiki_search`) with `query`, optional `wikiId`, `limit`, and
`maxCharsPerHit`. HTTP clients can `POST` the same JSON input to
`/remnic/v1/external-wikis/search` or `/engram/v1/external-wikis/search`.

Each hit includes its wiki id, page title, root-relative path, bounded snippet,
rank, score, and line-range citation. Search reads only configured catalog and
page paths and rejects catalog traversal outside `pagesDir`.

Dedicated wiki collection ids use the `external-wiki-` prefix. The recall
assembly path rejects hits from those collections before applying its result
limit. `qmdCollection` and `qmdColdCollection` cannot use the reserved prefix.
`wikiMergeIntoRecall` and `includeInDefaultRecall` default to `false`; Remnic
rejects `true` for either flag. Configuring roots does not change ordinary
recall or primary memory indexing.
