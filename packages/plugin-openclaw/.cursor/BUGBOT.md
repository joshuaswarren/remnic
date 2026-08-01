# Plugin OpenClaw Review Context

Adapter between `@remnic/core` and the OpenClaw gateway.

## Key Patterns
- Hooks register via `api.on("gateway_start")`, `api.on("before_prompt_build")`, `api.on("agent_end")`.
- Tools register via `api.registerTool()`.
- Commands register via `api.registerCommand()`.
- Services register via `api.registerService()`.
- Core package files must never have `openclaw-` prefix — host adapters wrap core, not the other way around.
