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
  `claude.ai` / `claude.com` -> `claude-ai` (`remnic_ca_`), anything else ->
  `oauth-app` (`remnic_oa_`). Suffix matching requires a dot boundary, so
  `evilclaude.ai` maps to `oauth-app`.
- Core exports `OAUTH_CONNECTOR_IDS` and `isOAuthConnector()`. The server
  path policy, server healthcheck token picker and CLI status probe use it,
  so every OAuth-minted token stays pinned to `/mcp` (no REST or operator
  access), exactly as ChatGPT tokens were.

## Tests (macstudio-1, branch `fix/oauth-per-app-connector-tokens`)

- `packages/remnic-server/src/oauth.test.ts`: 19/19 pass, including the new
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
migration is needed. ChatGPT's token issued before this fix was already
rotated by the Claude link and needs one re-link after deploy; after that,
each app keeps its own token.
