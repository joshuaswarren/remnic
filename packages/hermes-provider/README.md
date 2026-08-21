# @remnic/hermes-provider

Typed TypeScript HTTP client for a remote [Remnic](https://github.com/joshuaswarren/remnic)
memory daemon. Wraps the Remnic HTTP API (`/engram/v1/*`) with a small, fully
typed `HermesClient` — recall, observe, store, entity/memory browse, and LCM
search — plus built-in retries, timeouts, and structured errors.

Use this when you are building a service or agent in TypeScript/JavaScript that
talks to a Remnic daemon over HTTP and you want types and retry handling instead
of hand-rolled `fetch` calls.

## Install

```bash
npm install @remnic/hermes-provider
```

## Usage

```ts
import { HermesClient } from "@remnic/hermes-provider";

const client = new HermesClient({
  baseUrl: "http://127.0.0.1:4318",
  authToken: "${REMNIC_AUTH_TOKEN}",
});

// Verify the daemon is reachable.
await client.health();

// Recall memories for a query.
const { context } = await client.recall("what did I decide about the schema?");

// Buffer a conversation turn for extraction.
await client.observe("session-1", [
  { role: "user", content: "We are switching the store to markdown files." },
  { role: "assistant", content: "Understood — local-first it is." },
]);

// Store an explicit memory.
await client.store({ content: "Team prefers short release notes." });
```

## Client options

`new HermesClient(options)` accepts:

| Option | Default | Description |
| --- | --- | --- |
| `baseUrl` | required | Base URL of the Remnic daemon, e.g. `http://127.0.0.1:4318`. |
| `authToken` | required | Bearer token for the daemon. |
| `namespace` | unset | Default namespace applied to requests. |
| `sessionKey` | unset | Default session key applied to requests. |
| `maxRetries` | `3` | Retry budget for retryable failures (5xx, 429, read POSTs). |
| `retryBaseDelayMs` | `100` | Base delay for exponential backoff. |
| `timeoutMs` | `5000` | Per-request timeout (via `AbortController`). |

## Methods

- `health()` — daemon health probe.
- `recall(query, options?)` — semantic recall; `options` covers `topK`, `mode`,
  `namespace`, `sessionKey`, `includeDebug`, `idempotencyKey`.
- `observe(sessionKey, messages, options?)` — buffer conversation turns for
  extraction.
- `store(request)` / `submitSuggestion(request)` — write a memory directly, or
  queue one for review.
- `getEntities(options?)` / `getEntity(name, options?)` — browse tracked entities.
- `getMemories(options?)` / `getMemory(id, options?)` — browse stored memories.
- `lcmSearch(query, options?)` — search the Lossless Context Management archive.

All response and option types are exported from the package.

## Behavior

- **Retries** use exponential backoff on 5xx and read-only POSTs. 429 responses
  honor a numeric `Retry-After` header. State-mutating writes are not retried
  unless you pass an `idempotencyKey`, so a lost response never duplicates a write.
- **Errors** throw a typed `HermesError` carrying `status`, `code`, `message`, and
  optional field-level `details`. A 404 on `getEntity`/`getMemory` resolves to
  `{ found: false }` rather than throwing.

The `/engram/v1/*` request paths are Remnic's stable HTTP API surface, kept under
the `engram` prefix for compatibility.

## Links

- HTTP API reference: [docs/api.md](https://github.com/joshuaswarren/remnic/blob/main/docs/api.md)
- Monorepo: [github.com/joshuaswarren/remnic](https://github.com/joshuaswarren/remnic)

## License

MIT
