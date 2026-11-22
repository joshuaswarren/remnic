export function selfDeps<T extends object>(self: object): T {
  const source = self as Record<PropertyKey, unknown>;
  return new Proxy(Object.create(null) as object, {
    get(_target, prop) {
      const value = source[prop as string];
      return typeof value === "function" &&
        !Object.prototype.hasOwnProperty.call(value, "prototype")
        ? (value as (...args: unknown[]) => unknown).bind(self)
        : value;
    },
    set(_target, prop, value) {
      if (!((prop as string) in source)) return false;
      source[prop as string] = value;
      return true;
    },
    has(_target, prop) {
      return (prop as string) in source;
    },
  }) as unknown as T;
}
