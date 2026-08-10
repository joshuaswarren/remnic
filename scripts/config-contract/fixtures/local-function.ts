type Rec = Record<string, unknown>;
export function read(value: Rec, _fallback?: unknown): unknown {
  return value.global;
}

export function parseFixtureLocalFunctionConfig(value: unknown): Rec {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : {};
  const read = (key: string, sibling?: unknown): unknown => {
    void sibling;
    return raw[key];
  };
  const variableName = "variable";
  const computedName = "computed";
  const unhandled = () => {
    const key = raw.unhandled;
    return key;
  };
  const dynamicName = value as string;
  return {
    literal: read("literal", raw[dynamicName]),
    duplicate: read("literal", raw[dynamicName]),
    sibling: read("literal", raw.sibling),
    variable: read(variableName),
    computed: read(computedName),
    noArgument: read(),
    multipleArguments: read(variableName, computedName),
    unhandled: unhandled(),
  };
}

export function parseFixtureShadowedAlias(value: unknown): Rec {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : {};
  const key = raw;
  const read = (key: string): unknown => raw[key];
  return { enabled: read("enabled") };
}
