# External wiki search

Remnic can search operator-maintained compiled knowledge without copying it into
memory or injecting it into normal recall. Each root is a catalog plus markdown
concept pages:

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
`memoryDir`. The defaults expect `INDEX.md` and a `wiki/` page directory. Missing
catalogs degrade to markdown page-title discovery; one missing root does not
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
page paths. It rejects catalog traversal outside `pagesDir`.

External wiki search is always explicit. `includeInDefaultRecall` defaults to
`false`, and Remnic rejects `true`; configuring roots does not change normal
recall or primary memory indexing.
