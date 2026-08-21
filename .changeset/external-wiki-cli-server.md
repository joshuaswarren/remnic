---
"@remnic/cli": minor
"@remnic/server": minor
---

Add external compiled knowledge wiki search to the CLI and server packages. The CLI gains the `external-wiki` subcommand for on-demand search over Karpathy-style compiled wikis, and the server exposes the wiki search access operation over its HTTP API. Both consume the core config + search engine introduced in the wiki epic (#2058-#2061).
