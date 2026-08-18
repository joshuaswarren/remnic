# Prime Agent Integration

Remnic supports Prime Agent — a Pi-fork coding agent — through the same runtime
extension used for [Pi](./pi.md). The extension uses Prime Agent's
Pi-compatible extension hooks instead of wrapping the agent with a parallel
runtime.

> Using upstream Pi or the [Oh My Pi (omp)](https://omp.sh) fork? See
> [pi.md](./pi.md) and [omp.md](./omp.md).

## Install

Start the Remnic daemon, then install the connector:

```bash
remnic daemon start
remnic connectors install prime-agent
```

The installer writes into `~/.prime/agent/extensions/remnic/`:

- `index.ts` — auto-discovery wrapper (loaded directly; no bundling step, so
  `bun` is NOT required)
- `package.json` — private manifest depending on `@remnic/plugin-pi`, so Prime
  Agent's package-based extension discovery resolves the extension and a
  package install inside the directory makes its dependencies available
- `remnic.config.json` — private daemon URL, namespace, and auth token (`0600`)
- `README.md` — local operator notes

To use a non-default agent directory:

```bash
export PRIME_AGENT_CODING_AGENT_DIR=/path/to/agent
remnic connectors install prime-agent
```

Only `PRIME_AGENT_CODING_AGENT_DIR` relocates the install. The Pi-family env
vars (`PI_CODING_AGENT_DIR`, `PI_CONFIG_DIR`, …) do not apply to Prime Agent.

To skip writing the extension and only create the connector/token:

```bash
remnic connectors install prime-agent --config installExtension=false
```

To target a non-default daemon or namespace:

```bash
remnic connectors install prime-agent \
  --config remnicDaemonUrl=http://127.0.0.1:4318 \
  --config namespace=work
```

## What The Extension Does

The runtime extension is `@remnic/plugin-pi` — the same module Pi and omp use.
See [pi.md](./pi.md) for the full hook, slash-command, and configuration
reference. In short, it:

- Injects recalled Remnic context in the `before_agent_start` hook.
- Observes messages and tool activity with `sourceFormat: "pi"`.
- Coordinates `session_before_compact` with Remnic LCM flush and checkpoint
  recording.
- Registers Remnic MCP tools as agent tools when daemon authentication is
  configured.

## Remove

```bash
remnic connectors remove prime-agent
```

This removes the connector config and token, then sweeps the Remnic-owned
files from the extension directory (honoring `PRIME_AGENT_CODING_AGENT_DIR`).
User-created files in the directory are left untouched.
