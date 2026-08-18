---
"@remnic/core": patch
"@remnic/cli": patch
"@remnic/plugin-pi": patch
---

Add the `prime-agent` connector: `remnic connectors install prime-agent` installs the shared Pi-family memory extension into `~/.prime/agent/extensions/remnic` (relocatable via `PRIME_AGENT_CODING_AGENT_DIR`) for Prime Agent, a Pi-fork coding agent. Unlike the omp connector there is no bun pre-bundle — the install writes a plain `index.ts` wrapper plus a `package.json` depending on `@remnic/plugin-pi`. `remnic connectors remove prime-agent` sweeps that extension directory. Closes #2313.
