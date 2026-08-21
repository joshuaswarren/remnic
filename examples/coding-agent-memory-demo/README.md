# Coding Agent Memory Demo

This repo-level demo shows Remnic carrying scoped project memory from one coding
agent session to another. It uses no private API keys and makes no network
calls: the script creates a real `@remnic/core` `Orchestrator`, stores memories
through `EngramAccessService.memoryStore()`, then recalls them through
`EngramAccessService.recallXray({ includeRecall: true })`.

## Five-minute walkthrough

From the repository root:

```bash
pnpm run demo:coding-agent-memory
```

What happens:

1. `codex-cli:session-a` writes a checkout-service decision and preference into
   the real Remnic namespace `project-checkout-service`.
2. The same write path stores an unrelated marketing-site decision in the real
   namespace `project-marketing-site`.
3. `claude-code:session-b` recalls from `project-checkout-service` through real
   Remnic recall/X-ray.
4. The recall returns only checkout-service memories and explains why each
   surfaced.
5. The marketing-site memory does not surface because it is in a different
   namespace.

Expected terminal output:

```text
$ pnpm run demo:coding-agent-memory

> remnic-workspace@9.3.567 demo:coding-agent-memory /path/to/remnic
> NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--conditions=remnic-source" tsx examples/coding-agent-memory-demo/demo.mts

Remnic coding-agent memory demo
memoryDir: examples/coding-agent-memory-demo/.demo-memory
engine: real @remnic/core Orchestrator + EngramAccessService
apiKeys: none (OpenAI disabled, QMD disabled)

1) codex-cli / session-a stores real Remnic memories via memoryStore()
stored decision "checkout retry-policy decision" -> namespace=project-checkout-service status=stored
stored preference "checkout change-note preference" -> namespace=project-checkout-service status=stored
stored decision "marketing-site unrelated decision" -> namespace=project-marketing-site status=stored

2) switch to claude-code / session-b and recall through recallXray(includeRecall=true)
active namespace: project-checkout-service
query: payment retry policy decision and change notes
recalled 2 real Remnic memories
- preference
  content: Preference: for checkout-service, include the retry-policy file path in change notes before code edits.
  why: scope=namespace:project-checkout-service; servedBy=recent-scan; served-by=recent-scan
- decision
  content: Decision: checkout-service payment retry policy lives in src/payments/retry-policy.ts and uses idempotency keys with a maximum of 3 attempts.
  why: scope=namespace:project-checkout-service; servedBy=recent-scan; served-by=recent-scan

3) scope check
checkout namespace: project-checkout-service
unrelated namespace: project-marketing-site
xray filter: tag-filter admitted 2/2
marketing memory surfaced: no
result: PASS - claude-code:session-b recalled checkout-service context written by codex-cli:session-a using real Remnic storage and recall.
```

The generated demo memory files live under
`examples/coding-agent-memory-demo/.demo-memory/`, which is gitignored. Delete
that directory whenever you want a fresh run; the demo also resets only that
built-in directory by default.

Custom memory directories are preserved unless you explicitly pass `--reset`.
For safety, reset only removes the built-in demo directory, an absent or empty
custom directory, or a custom directory already marked by a previous demo run:

```bash
pnpm run demo:coding-agent-memory -- --memory-dir /tmp/remnic-demo
pnpm run demo:coding-agent-memory -- --memory-dir /tmp/remnic-demo --reset
```

## Smoke test

Run the scriptable smoke test:

```bash
node examples/coding-agent-memory-demo/smoke-test.mjs
```

Or use the root package script:

```bash
pnpm run test:coding-agent-memory-demo
```

Expected output:

```text
PASS coding-agent-memory-demo smoke test
```

## Why this is real and offline

Production Remnic integrations normally reach the same access-service through
the daemon, HTTP, MCP, hooks, or host adapters. This demo runs that access
service in-process so it can be checked from a source checkout without starting
a daemon. The write and recall paths are real Remnic paths:

- `EngramAccessService.memoryStore()` validates namespace ACLs and persists via
  explicit capture into `StorageManager.writeMemory()`.
- `EngramAccessService.recallXray()` delegates to `Orchestrator.recall()`,
  captures X-ray provenance, and returns a recall response from the same
  snapshot.
- Namespace policies scope the checkout-service and marketing-site memories.

OpenAI, QMD, local LLMs, embeddings, and direct-answer annotation are disabled
so the demo is deterministic and requires no credentials.
