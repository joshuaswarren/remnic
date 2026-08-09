type Rec = Record<string, unknown>;

export function parseFixtureLocalFunctionConfig(value: unknown): Rec {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : {};
  const read = (key: string): unknown => raw[key];
  const variableName = "variable";
  const computedName = `computed`;
  return {
    literal: read("literal"),
    duplicate: read("literal"),
    variable: read(variableName),
    computed: read(computedName),
    noArgument: read(),
    multipleArguments: read(variableName, computedName),
  };
}

export function parseFixtureShadowedAlias(value: unknown): Rec {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : {};
  const key = raw;
  const read = (key: string): unknown => raw[key];
  return { enabled: read("enabled") };
}
