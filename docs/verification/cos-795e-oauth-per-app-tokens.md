# Verification: per-app OAuth connector tokens (COS-795e)

## Problem

Claude and ChatGPT share the single pre-registered OAuth client. The token
exchange always minted under connector id `chatgpt`, and `commitTokenEntry`
replaces the previous entry for a connector id. Linking Claude on 2026-11-26
at 11:17 PM CT therefore revoked ChatGPT's token, and re-linking ChatGPT
would revoke Claude's.

## Fix

- `oauthConnectorIdForRedirect()` (remnic-server `oauth.ts`) picks the
  connector id from the allowlist-validated redirect URI bound to the code:
  `chatgpt.com` / `openai.com` -> `chatgpt` (unchanged, `remnic_cg_`),
  `claude.ai` / `claude.com` -> `claude-ai` (`remnic_ca_`), any other app ->
  a unique `oauth-app-<origin>` id (`remnic_oa_`): the percent-encoded
  origin with scheme and port kept (`https://app.example.com:8443` ->
  `oauth-app-https%3A%2F%2Fapp.example.com%3A8443`), so distinct origins —
  different schemes, hosts, ports, or lookalike labels — never
  collide into one id or rotate each other's tokens. Loopback native apps
  (RFC 8252) get the same per-origin ids; a client that relinks on a new
  port keeps its prior connector id and token alongside the new one.
  Suffix matching requires a dot boundary, so `evilclaude.ai` maps to
  `oauth-app-https%3A%2F%2Fevilclaude.ai`.
- Core exports `OAUTH_CONNECTOR_IDS` and `isOAuthConnector()`. The server
  path policy, server healthcheck token picker and CLI status probe use it,
  so every OAuth-minted token stays pinned to `/mcp` (no REST or operator
  access), exactly as ChatGPT tokens were.

## Tests (macstudio-1, branch `fix/oauth-per-app-connector-tokens`)

- `packages/remnic-server/src/oauth.test.ts`: 19/19 pass, including the new (third-app case included)
  - "per-app tokens: linking Claude never revokes ChatGPT's token, and vice
    versa" (both directions, own-token rotation still works, Claude token
    denied on `/engram/v1/health` and `/oauth/pending`, store holds exactly
    `chatgpt` + `claude-ai`)
  - "oauthConnectorIdForRedirect maps hosts to per-app connector ids"
- `packages/remnic-cli/src/status-health-auth.test.ts`: 9/9 pass.
- `packages/remnic-core/src/access-http.test.ts`: 108/108 pass.
- `@remnic/server` `check-types`: clean.

## Deploy note

Existing ChatGPT token entries keep connector id `chatgpt`, so no store
migration is needed. Where Claude was linked before this fix (as on
2026-11-26 at 11:17 PM CT), Claude's live token sits in the legacy `chatgpt`
entry and ChatGPT's token was already revoked. After deploy, re-link BOTH
apps: Claude's re-link creates its own `claude-ai` entry, and ChatGPT's
re-link replaces the legacy `chatgpt` entry. After both re-links, each app
holds its own token in a separate entry.
