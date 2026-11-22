# WeClone install composes config from defaults then user overrides, and install/run/remove share one path-resolution rule

Status: accepted

## Context
The WeClone connector persists a proxy config (default `~/.remnic/connectors/weclone.json`) so the standalone `remnic-weclone-proxy` CLI can start without extra setup, and the registry tracks the file so `list/remove/doctor` work uniformly. Memory-injection settings come from three sources (defaults, prior saved values, user overrides), and paths are computed from environment variables by both the installer and the CLI. Divergence between how install and run resolve the same variable silently breaks installs.

## Decision
- `remnic connectors install weclone` composes and persists the proxy config; the same file is tracked by the connector registry.
- Memory-injection merge starts from defaults, shallow-merges prior values, then user overrides; deep field validation is the proxy's `parseConfig()` job at startup, not the composer's. Arrays are explicitly rejected as override values (`typeof [] === "object"` would otherwise spread numeric-indexed properties into the merged object).
- Token precedence: freshly minted → user-supplied → prior saved; no token is written when none is available (the proxy tolerates a missing token by not sending Authorization headers).
- Install and run must agree on path resolution: `path.join`-style install results and `path.resolve`-style run-time reads are normalized so a relative override like `REMNIC_HOME=tmp/remnic` yields the same absolute path on both sides; an empty HOME falls back to `os.homedir()` (empty string is not nullish), never to a CWD-relative path.
- Failures during a proxy-config replace must not corrupt the prior file: the rollback closure is installed before the write and restores prior contents on failure.

## Consequences
The composer stays best-effort and permissive; malformed overrides surface later as clean proxy startup errors instead of install-time crashes. Path normalization must be kept in lock-step across installer and CLI — a change on one side alone reintroduces the run-time "file not found" class of bug.

## Merged themes
`weclone-proxy-config`, `weclone-compose`, `weclone-proxy-path-normalization`, `weclone-home-empty-parity`, and `weclone-memory-injection-array-reject` records describe one install/compose family and are merged here.

## Origin comments
- `packages/remnic-core/src/connectors/index.ts:3812` — "// The standalone `remnic-weclone-proxy` CLI reads its config from"
- `packages/remnic-core/src/connectors/index.ts:3813` — "// ~/.remnic/connectors/weclone.json by default. `remnic connectors install"
- `packages/remnic-core/src/connectors/index.ts:3814` — "// weclone` composes and persists that file so the proxy can start without"
- `packages/remnic-core/src/connectors/index.ts:3815` — "// additional setup. The file is also tracked by the connector registry (at"
- `packages/remnic-core/src/connectors/index.ts:3816` — "// getConnectorsDir()/weclone.json) so `remnic connectors list/remove/doctor`"
- `packages/remnic-core/src/connectors/index.ts:3817` — "// work uniformly across all connectors."
- `packages/remnic-core/src/connectors/index.ts:4016` — "// Memory injection: always start from defaults, then shallow-merge any"
- `packages/remnic-core/src/connectors/index.ts:4017` — "// prior values, then user overrides. Individual field validation happens in"
- `packages/remnic-core/src/connectors/index.ts:4018` — "// the proxy's parseConfig() at proxy startup — here we only assemble a"
- `packages/remnic-core/src/connectors/index.ts:4019` — "// best-effort shape. A malformed user override would be rejected later with"
- `packages/remnic-core/src/connectors/index.ts:4020` — "// a clean error message."
- `packages/remnic-core/src/connectors/index.ts:4022` — "// `typeof [] === "object"` so a bare `typeof ... === "object" && ... !=="
- `packages/remnic-core/src/connectors/index.ts:4023` — "// null` guard would let an array spread numeric-indexed properties into"
- `packages/remnic-core/src/connectors/index.ts:4024` — "// the merged object, silently corrupting it. Explicitly reject arrays."
- `packages/remnic-core/src/connectors/index.ts:4049` — "// Token precedence: freshly minted token → user-supplied → prior saved."
- `packages/remnic-core/src/connectors/index.ts:4050` — "// Never write a token if none is available — the proxy tolerates missing"
- `packages/remnic-core/src/connectors/index.ts:4051` — "// tokens (it just won't send Authorization headers to the daemon)."
- `packages/remnic-core/src/connectors/weclone-installer.test.ts:328` — "// Reviewer feedback (codex P2): install (path.join) and run (path.resolve)"
- `packages/remnic-core/src/connectors/weclone-installer.test.ts:329` — "// must agree on normalization. With a relative override like"
- `packages/remnic-core/src/connectors/weclone-installer.test.ts:330` — "// `REMNIC_HOME=tmp/remnic`, `path.join` keeps it relative while"
- `packages/remnic-core/src/connectors/weclone-installer.test.ts:331` — "// `path.resolve` makes it absolute — if they disagree, run-time fails"
- `packages/remnic-core/src/connectors/weclone-installer.test.ts:332` — "// to locate the file install-time wrote. Verified by asserting"
- `packages/remnic-core/src/connectors/weclone-installer.test.ts:333` — "// absoluteness here."
- `packages/remnic-core/src/connectors/weclone-installer.test.ts:784` — "// Reviewer (cursor LOW): typeof [] === "object", so a bare object+null"
- `packages/remnic-core/src/connectors/weclone-installer.test.ts:785` — "// guard would let an array spread numeric-indexed properties into the"
- `packages/remnic-core/src/connectors/weclone-installer.test.ts:786` — "// merged memoryInjection. The helper must reject arrays explicitly."
- `packages/remnic-core/src/connectors/weclone-installer.test.ts:802` — "// the home (empty string is NOT nullish). Without the parity fix, install"
- `packages/remnic-core/src/connectors/weclone-installer.test.ts:803` — "// and run would disagree whenever HOME is empty. Both must fall back to"
- `packages/remnic-core/src/connectors/weclone-installer.test.ts:804` — "// os.homedir() so they pick the same directory."
- `packages/remnic-core/src/connectors/weclone-installer.test.ts:805` — "//"
- `packages/remnic-core/src/connectors/weclone-installer.test.ts:806` — "// Strategy: assert the result matches the os.homedir()-based path exactly,"
- `packages/remnic-core/src/connectors/weclone-installer.test.ts:807` — "// which is what the CLI computes. If HOME="" were used verbatim, the"
- `packages/remnic-core/src/connectors/weclone-installer.test.ts:808` — "// result would be resolve("", ...) ≡ resolve(".remnic/connectors/...") —"
- `packages/remnic-core/src/connectors/weclone-installer.test.ts:809` — "// i.e. CWD-relative — which must NOT be the returned path."
