api.on("before_prompt_build", async () => {});
api.on("agent_end", async () => {});
registerCli(api as unknown as Foo, orchestrator);
api.registerService({ id: "openclaw-engram", start: async () => {}, stop: () => {} });
