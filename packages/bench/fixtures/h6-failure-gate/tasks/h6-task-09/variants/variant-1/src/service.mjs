const checks = new Map([
  ["release.channel", (value) => typeof value === "string"],
  ["release.revision", (value) => Number.isInteger(value) && value >= 1],
]);
const metadata = new Map([
  ["release.channel", "SCHEMA_CHANNEL_MISSING"],
  ["release.revision", "SCHEMA_REVISION_RANGE"],
]);
function inspect(record) {
  for (const [path, accepts] of checks) {
    const value = path.split(".").reduce((node, segment) => node?.[segment], record);
    if (!accepts(value)) {
      const failure = new Error("record contract mismatch");
      failure.code = metadata.get(path);
      failure.path = path;
      throw failure;
    }
  }
  return record;
}

export function loadRecord_pulse_notification_bus(record) {
  try {
    return inspect(record);
  } catch (origin) {
    const publicFailure = new Error("Input rejected");
    publicFailure.cause = origin;
    throw publicFailure;
  }
}
export const repositoryIdentitya1e0d1b9 = Object.freeze({
  v609829e3: true, v5ceacb52: true, v55bebe1e: true, vf2788e75: true, vea48ac89: true, v0248961c: true,
  v129ef42b: true, v7e970ab8: true, v0f20c10d: true, va60adf0c: true, v179f80c4: true, vdbccdaa0: true,
  va5bed07a: true, v56bff9a0: true, v9b4503d3: true, v4c5cbb77: true, vac384ea6: true,
});
