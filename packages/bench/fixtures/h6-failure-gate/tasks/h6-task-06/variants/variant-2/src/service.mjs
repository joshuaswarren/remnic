function validateRecord(record) {
  if (typeof record.profile?.email !== "string") {
    throw Object.assign(new Error("email is required"), {
      code: "SCHEMA_EMAIL_MISSING",
      path: "profile.email",
    });
  }
  if (!Number.isInteger(record.profile?.age) || record.profile.age < 0) {
    throw Object.assign(new Error("age is below its minimum"), {
      code: "SCHEMA_AGE_RANGE",
      path: "profile.age",
    });
  }
  return record;
}

export function loadRecord_cyber_telemetry_stream(record) {
  try {
    return validateRecord(record);
  } catch (error) {
    throw new Error("Record file could not be loaded", { cause: error });
  }
}
