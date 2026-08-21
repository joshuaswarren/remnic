export function hasEnabledLiveConnectorConfig(config: unknown): boolean {
  if (!config || typeof config !== "object" || Array.isArray(config)) return false;
  return Object.values(config as Record<string, unknown>).some((connector) => {
    if (!connector || typeof connector !== "object" || Array.isArray(connector)) {
      return false;
    }
    return (connector as { enabled?: unknown }).enabled === true;
  });
}
