function validateRecord(record) {
  if (typeof record.asset?.label !== "string") {
    throw Object.assign(new Error("label is required"), {
      code: "SCHEMA_LABEL_MISSING",
      path: "asset.label",
    });
  }
  if (!Number.isInteger(record.asset?.weight) || record.asset.weight < 0) {
    throw Object.assign(new Error("weight is below its minimum"), {
      code: "SCHEMA_WEIGHT_RANGE",
      path: "asset.weight",
    });
  }
  return record;
}

export function loadRecord_vector_session_store(record) {
  return validateRecord(record);
}
