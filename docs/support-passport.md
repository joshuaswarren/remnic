# What Helps Me support passport

What Helps Me is an optional, owner-controlled support passport. It turns
selected Remnic memories into short support cards. A helper sees only the exact
approved card revisions that the owner shares.

The feature uses the owner-first principles in
[NHS England's health and care passport guidance](https://www.england.nhs.uk/long-read/health-and-care-passports-implementation-guidance/).
The person chooses the content, support, audience, and review time. The passport
must also stay useful across settings.

What Helps Me is a self-advocacy tool. It is not a medical record, care plan,
IEP, diagnosis tool, or emergency guide.

## Product rules

- The model is the scribe. The person is the author.
- A new card always starts as `pending_review`.
- The owner approves each card separately.
- A share link pins exact card revisions.
- A helper cannot search Remnic or change a card.
- The owner can stop sharing at any time.

The cards remain normal `preference` memories. Remnic does not create another
memory store. Each card has the `support-passport-card` tag and uses the normal
memory lifecycle.

## Enable the feature

The feature is off by default. An OpenClaw install can enable the passport,
the owner HTTP routes, and gateway model routing together:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-remnic": {
        "config": {
          "modelSource": "gateway",
          "openaiApiKey": false,
          "supportPassport": { "enabled": true },
          "agentAccessHttp": {
            "enabled": true,
            "host": "127.0.0.1",
            "port": 4318,
            "authToken": "${OPENCLAW_REMNIC_ACCESS_TOKEN}",
            "principal": "passport-owner"
          }
        }
      }
    }
  }
}
```

Set `OPENCLAW_REMNIC_ACCESS_TOKEN` to a private bearer token before OpenClaw
starts. You can use an OpenClaw SecretRef for `authToken` instead.

A standalone `remnic-server` install uses this configuration:

```jsonc
{
  "server": {
    "host": "127.0.0.1",
    "port": 4318,
    "authToken": "${REMNIC_AUTH_TOKEN}",
    "principal": "passport-owner"
  },
  "remnic": {
    "supportPassport": { "enabled": true }
  }
}
```

Set `REMNIC_AUTH_TOKEN` before the server starts. The `principal` value defines
the owner for every authenticated owner request. When namespaces are enabled,
give that principal access through the matching namespace policy.

## Choose a model route

What Helps Me does not require the OpenAI API. It uses the same model routing
that other Remnic tasks use.

| Route | Remnic configuration | What happens |
|---|---|---|
| OpenClaw gateway | `modelSource: "gateway"` | `FallbackLlmClient` uses the configured gateway agent or task model chain. |
| Local model | `modelSource: "plugin"`, `openaiApiKey: false`, and `localLlmEnabled: true` | `LocalLlmClient` uses the configured OpenAI-compatible local endpoint. |
| Direct OpenAI | `modelSource: "plugin"` and `openaiApiKey` | The existing fallback client uses the official Responses transport. |
| Compatible remote endpoint | `modelSource: "plugin"`, `openaiBaseUrl`, and `openaiApiKey` | The existing compatible transport uses that endpoint. |

Plugin mode tries the configured local route first. When `localLlmFallback`
permits fallback, it can continue through configured direct and gateway routes.
Gateway mode uses only the OpenClaw gateway chain.

The OpenClaw example above keeps the current `agents` and `models.providers`
configuration unchanged. The adapter supplies its gateway configuration and
native provider auth resolvers to Remnic. What Helps Me does not create another
API client.

Manual cards, approval, sharing, and revocation need no model. Draft and
question requests return `503 provider_unavailable` when no route can run.
Remnic never inserts a fixed answer.

## Security model

Owner routes use the normal Remnic bearer boundary. The trusted transport
principal defines the owner namespace. A request cannot supply its own actor or
namespace.

Helper routes accept only `Authorization: SupportPassport <secret>`. Remnic
stores only a SHA-256 secret hash. It compares hashes in constant time.

Each helper request reads durable grant state. The request checks the secret,
expiry, revocation state, card lifecycle, and exact revision. One mismatch
locks the full guide. The response never returns a partial card set.

Public responses set `Cache-Control: private, no-store` and
`Vary: Authorization`. Read and question limits apply to both the grant and a
SHA-256 network digest. Remnic stores no raw network address.

Remnic ignores forwarded addresses by default. If a reverse proxy serves the
helper routes, list its exact IP address in
`supportPassport.trustedProxyAddresses`. The proxy must overwrite or safely
append `X-Forwarded-For`. Remnic then walks the proxy chain from the trusted
connection toward the first untrusted client address.

See the [support passport threat model](security/support-passport-threat-model.md)
for the full boundaries.

## Model privacy

Draft calls send only notes that the owner selected. Question calls send only
the shared public cards and the helper question. Both prompts treat supplied
text as untrusted data. Neither call gives the model tools.

Remnic requests `store: false` where the selected route supports it. This flag
is not the same as Zero Data Retention. Review the retention terms for the
configured provider and account before sending private notes.

Model audit files contain route, model, schema version, time, latency, token
counts, outcome, and hashes. They contain no note text, card text, prompt,
answer, secret, token, or raw principal.

## HTTP routes

Owner routes use the normal bearer token:

```text
GET  /engram/v1/support-passport/memories/:memoryId
GET  /engram/v1/support-passport/cards
POST /engram/v1/support-passport/drafts
POST /engram/v1/support-passport/drafts/generate
PUT  /engram/v1/support-passport/cards/:cardId
POST /engram/v1/support-passport/cards/:cardId/approve
POST /engram/v1/support-passport/cards/:cardId/reject
POST /engram/v1/support-passport/cards/:cardId/withdraw
POST /engram/v1/support-passport/grants
GET  /engram/v1/support-passport/grants
POST /engram/v1/support-passport/grants/:grantId/revoke
```

The memory preview returns the exact text shown for consent and an opaque
revision. Send each selected `memoryId` and `revision` in
`sourceMemoryRevisions` with the draft request. Remnic rejects changed text
before a model call.

The card list also returns each approved card's revision. Send the selected
`cardIds` and matching `{ cardId, revision }` entries in `cardRevisions` when
you create a share link. Remnic rejects a changed card before it creates the
link.

Public routes use the support-passport secret:

```text
GET  /engram/v1/support-passport/public/grants/:grantId
POST /engram/v1/support-passport/public/grants/:grantId/ask
```

The same owner actions are available as feature-gated MCP tools. Public helper
actions never enter the generic operation list.
