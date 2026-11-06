# Community numbers

Every figure on this page is a measured read from a public source, listed with
the command or URL that produced it and the date it was read. Nothing here is
estimated, extrapolated, or quoted from users. Re-run the commands to get
current numbers.

## Measured figures

| Metric | Value | Source | Read |
|---|---|---|---|
| Stars | 233 | Repo API, `stargazers_count` | 2026-11-06 |
| Forks | 29 | Repo API, `forks_count` | 2026-11-06 |
| People named in CONTRIBUTORS.md | 12 (1 maintainer + 11 community) | [CONTRIBUTORS.md](CONTRIBUTORS.md) at commit `a2fd0e6c9` (v10.0.79) | 2026-11-06 |
| Contributor accounts in GitHub API | 16 (12 human + 4 bot) | Contributors API, `anon=false` | 2026-11-06 |

Commands behind the numbers:

```bash
gh api repos/joshuaswarren/remnic --jq '{stars: .stargazers_count, forks: .forks_count}'
gh api 'repos/joshuaswarren/remnic/contributors?per_page=100&anon=false' --jq 'length'
grep -cE '^- \[@' CONTRIBUTORS.md   # 23 = 12 curated (1 maintainer + 11 community) + 11 registry entries
```

The 4 bot accounts in the API list are `github-actions[bot]`,
`wal-fleet-agent[bot]`, `dependabot[bot]`, and `cursoragent`.

## The two contributor counts do not match name-for-name

Both counts are 12 humans, but the sets differ, and this page reports the
divergence instead of reconciling it:

- `@TheNumberOne` appears in the API commit-author list and not in
  CONTRIBUTORS.md.
- `@100menotu001` is named in CONTRIBUTORS.md and does not appear in the API
  commit-author list.

CONTRIBUTORS.md explains the mechanics: its generated registry is rebuilt
weekly by `.github/workflows/contributors.yml` from non-anonymous commit
authors plus merged pull-request authors (maintainer, bot, and coding-agent
accounts excluded), while the curated sections are maintained by hand.

## Where to look next

- [Discussion #3277: How do you use Remnic?](https://github.com/joshuaswarren/remnic/discussions/3277) —
  open feedback thread. As of 2026-11-06 it has 0 comments and 1 upvote.
- [Accessibility](ACCESSIBILITY.md) — states directly that Joshua is the only
  verified user represented there, and that GitHub activity does not tell us
  who uses Remnic or whether it helps them.
- [How I use Remnic every day](docs/DAILY-USE.md) (merged in
  [#3319](https://github.com/joshuaswarren/remnic/pull/3319)) — a measured
  30-day single-user log where every number carries the command that produced
  it.

## Not measured

No download, install, active-user, retention, or satisfaction numbers are
published here because none are measured. Stars and forks measure GitHub
activity, not usage. No user quotes are published anywhere on this page; if
[#3277](https://github.com/joshuaswarren/remnic/discussions/3277) collects
feedback, it stays there rather than being repurposed as marketing.
