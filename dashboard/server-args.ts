export function readDashboardArg(args: readonly string[], flag: string, fallback?: string): string | undefined {
  const idx = args.findIndex((arg) => arg === flag);
  if (idx === -1) return fallback;
  const value = args[idx + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing ${flag}`);
  }
  return value;
}

export function parseDashboardPort(raw: string | undefined): number {
  const value = raw ?? "4319";
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error(`invalid --port: ${raw}`);
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid --port: ${raw}`);
  }
  return port;
}
