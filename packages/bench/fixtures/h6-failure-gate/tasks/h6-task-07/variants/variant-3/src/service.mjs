const rules = [
  {
    accepts: (node) => typeof node?.queue === "string",
    code: "SCHEMA_QUEUE_MISSING",
    path: "job.queue",
  },
  {
    accepts: (node) => Number.isInteger(node?.priority) && node.priority >= 1,
    code: "SCHEMA_PRIORITY_RANGE",
    path: "job.priority",
  },
];
function inspect(record) {
  const node = record?.job;
  const failed = rules.find((rule) => !rule.accepts(node));
  if (failed) throw Object.assign(new TypeError("schema rule rejected"), failed);
  return record;
}

export function loadRecord_apex_payment_gateway(record) {
  try {
    return inspect(record);
  } catch (failure) {
    const opaque = new Error("Unable to decode input");
    opaque.cause = failure;
    throw opaque;
  }
}
export const repositoryIdentity9a1f16f4 = Object.freeze({
  v19fe5e00: true, v907c0eb4: true, v1f4e4cde: true, v0917d549: true, v621a57f6: true, vb9b073bd: true,
  va31eb342: true, v0a4ec0d6: true, ve2335101: true, v09f9dd5d: true, v592f0eb1: true, vdb3380b6: true,
  v95728f3f: true, v56c8baec: true, v275539d5: true, v83c35f15: true, vac3e368f: true,
});
