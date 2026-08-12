# Support passport threat model

This document defines the security boundary for What Helps Me. The feature is
disabled unless `supportPassport.enabled` is `true`.

## Protected data

- Selected memory text and memory IDs.
- Owner identity and namespace.
- Draft and approved card text.
- Grant secrets and stored secret hashes.
- Helper questions and model answers.
- Model prompts and provider credentials.

## Trust boundaries

The owner side trusts the normal Remnic bearer-token boundary. The server
derives the owner from the authenticated transport principal.

The helper side trusts one narrow grant. The grant contains exact card IDs and
revision hashes. It does not grant general memory, MCP, owner, or search access.

The configured model is an external data processor unless it runs locally.
Model output is untrusted input. Strict schemas and citation checks validate it.

## Main threats and controls

| Threat | Control |
|---|---|
| A client supplies another owner or namespace. | Owner inputs contain neither field. The trusted principal resolves the namespace. |
| A leaked link appears in server logs. | The UI keeps the secret in the URL fragment. It removes the fragment after reading it. |
| A guessed or stolen grant opens wider access. | Grants use random 32-byte secrets, constant-time hash checks, expiry, and exact card revisions. |
| A stopped link remains usable through a cache. | Every helper call reads durable state. Open views normally poll every 30 seconds and back off to five minutes after rate limits. Public responses use `private, no-store`. |
| One changed card leaks a partial guide. | Any state or revision mismatch returns `410 grant_stale` with no cards. |
| A helper widens the scope. | Public inputs accept only a question. They accept no namespace, memory ID, path, search, or scope. |
| A prompt attack adds facts or citations. | Prompts mark content as data. Strict schemas reject unknown fields and unknown citations. |
| A model invents an unsupported answer. | Grounded answers need an included card citation. Uncovered questions use one fixed fallback. |
| A selected note changes after review. | The owner API binds the previewed text to a revision. Drafting rejects a mismatch before a model call. |
| Private text enters logs or receipts. | Audit records omit private text. Public run receipts omit private text, raw model IDs, secrets, and paths. |
| Repeated requests extract or overload data. | Per-grant and hashed-network limits apply to reads and questions. |
| A linked or corrupt grant file escapes the store. | The grant store rejects unsafe paths, linked state, and invalid strict records. |
| Concurrent revoke and read returns old data. | Grant mutations use file locks, serialized writes, state versions, and durable reads. |

## Data sent to models

The draft call receives exact selected notes and their IDs. It receives no
other memory. The owner must send `consent: true` before this call.

The question call receives exact public cards and one question. It receives no
owner namespace, source memory, raw path, lifecycle data, or other Remnic
context.

The model receives no tools. Remnic requests `store: false` where the route
supports it. This flag does not provide Zero Data Retention.

## Data at rest

Support cards use the normal Remnic memory store. Grant records use
`state/support-passport/grants/`. Model audits use
`state/support-passport/audit/`.

Grant files contain a secret hash and an owner-principal hash. They never
contain the raw secret. Owner grant listings return neither secret hash.

The UI stores no owner token or helper secret in cookies, local storage, or
session storage.

## Response rules

A bad secret or missing grant returns `404`. An expired grant returns
`410 grant_expired` only after secret validation. A stopped grant returns
`410 grant_gone`. A stale card revision returns `410 grant_stale` with no card
content.

The public adapter sets these headers on every owned response:

```text
Cache-Control: private, no-store
Vary: Authorization
```

## Out of scope

- A process that can read the owner's Remnic files.
- A compromised owner bearer token.
- A compromised helper device after it displays an active guide.
- Provider retention beyond the guarantees of the configured provider account.
- Screenshots or copies that a helper makes after authorized access.
