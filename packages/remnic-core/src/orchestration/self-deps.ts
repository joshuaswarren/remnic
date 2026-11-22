export function selfDeps<T extends object>(self: object): T {
  const source = self as Record<PropertyKey, unknown>;
  return new Proxy(Object.create(null) as object, {
    get(_target, prop) {
      const value = source[prop as string];
      // Bind ONLY prototype/concise methods (they have no own `prototype`
      // property). Class-valued deps (e.g. `storageManagerClass`, used by
      // the storage decomposition to reach shared static caches) must pass
      // through unbound: Function.prototype.bind returns a bound function
      // WITHOUT the original's own static properties, which silently
      // strips the class's statics. Plain data and arrows also pass
      // through unchanged (arrows ignore bind receivers anyway).
      return typeof value === "function" &&
        !Object.prototype.hasOwnProperty.call(value, "prototype")
        ? (value as (...args: unknown[]) => unknown).bind(self)
        : value;
    },
    set(_target, prop, value) {
      // Fail fast on writes to properties the orchestrator does not
      // declare (Kilo review on PR #1801): returning false makes the
      // assignment throw a TypeError in strict mode, matching the
      // error-safety of the hand-written accessor blocks this factory
      // replaced. Legitimate gate-field writes (deferredReady,
      // lastXraySnapshot, …) all target existing members.
      if (!((prop as string) in source)) return false;
      source[prop as string] = value;
      return true;
    },
    has(_target, prop) {
      return (prop as string) in source;
    },
  }) as unknown as T;
}
