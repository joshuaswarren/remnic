function validateRecord(record) {
  if (typeof record.region?.zone !== "string") {
    throw Object.assign(new Error("zone is required"), {
      code: "SCHEMA_ZONE_MISSING",
      path: "region.zone",
    });
  }
  if (!Number.isInteger(record.region?.quota) || record.region.quota < 5) {
    throw Object.assign(new Error("quota is below its minimum"), {
      code: "SCHEMA_QUOTA_RANGE",
      path: "region.quota",
    });
  }
  return record;
}

export function loadRecord_quantum_order_pipeline(record) {
  return validateRecord(record);
}
