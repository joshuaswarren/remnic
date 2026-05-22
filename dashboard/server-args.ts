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
