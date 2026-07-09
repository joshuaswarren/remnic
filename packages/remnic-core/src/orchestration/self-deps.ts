/**
 * Live self-deps factory (issue #1526 seam 27).
 *
 * Every coordinator extracted from the orchestrator (seams 4–26) takes a
 * deps bundle whose property names MATCH the orchestrator's own member
 * names, wired as live accessors / late-binding arrows so instance-level
 * test stubs and subclass overrides keep taking effect. Those hand-written
 * wiring blocks were ~100 lines each and pure repetition. This factory
 * replaces them with a Proxy that preserves the exact semantics:
 *
 *   - property GET reads `self[prop]` live on every access (late binding —
 *     an instance stub installed after coordinator creation is observed);
 *   - method properties are bound to `self` at access time, so `this`
 *     inside the orchestrator method stays the orchestrator;
 *   - property SET writes through to `self` (gate fields like
 *     `deferredReady` / `lastXraySnapshot` stay on the orchestrator);
 *   - getters on `self` (e.g. `fastLlmForRerank`) are invoked live.
 *
 * The `as unknown as T` cast is deliberate: the deps interfaces reference
 * the orchestrator's PRIVATE members, which TypeScript cannot verify
 * structurally from outside the class. The interfaces remain fully
 * enforced on the coordinator side. Per-access `bind` costs nanoseconds
 * and allocates one closure per property access — negligible against the
 * I/O-bound work every coordinator method performs.
 */
export function selfDeps<T extends object>(self: object): T {
  const source = self as Record<PropertyKey, unknown>;
  return new Proxy(Object.create(null) as object, {
    get(_target, prop) {
      const value = source[prop as string];
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(self)
        : value;
    },
    set(_target, prop, value) {
      source[prop as string] = value;
      return true;
    },
    has(_target, prop) {
      return (prop as string) in source;
    },
  }) as unknown as T;
}
