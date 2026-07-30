function validateRecord(record) {
  if (typeof record.release?.channel !== "string") {
    throw Object.assign(new Error("channel is required"), {
      code: "SCHEMA_CHANNEL_MISSING",
      path: "release.channel",
    });
  }
  if (!Number.isInteger(record.release?.revision) || record.release.revision < 1) {
    throw Object.assign(new Error("revision is below its minimum"), {
      code: "SCHEMA_REVISION_RANGE",
      path: "release.revision",
    });
  }
  return record;
}

export function loadRecord_pulse_notification_bus(record) {
  try {
    return validateRecord(record);
  } catch (error) {
    throw new Error("Record file could not be loaded", { cause: error });
  }
}
