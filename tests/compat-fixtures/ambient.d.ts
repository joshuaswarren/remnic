// Ambient globals for the compat-fixture sample plugin sources under
// tests/compat-fixtures/*/src/index.ts. Those fixtures emulate external
// OpenClaw plugin entrypoints that receive `api`/`orchestrator` from the host
// at runtime, so they legitimately reference names no import provides. This
// declares that host surface for the test typecheck (no runtime effect).
declare const api: {
  on(event: string, handler: (...args: unknown[]) => unknown): void;
  registerService(service: {
    id: string;
    start: () => Promise<void> | void;
    stop: () => Promise<void> | void;
  }): void;
};
declare const orchestrator: unknown;
declare function registerCli(pluginApi: unknown, orch: unknown): void;
type Foo = unknown;
