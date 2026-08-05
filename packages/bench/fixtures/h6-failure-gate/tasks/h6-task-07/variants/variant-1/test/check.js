import { repositoryIdentity9a1f16f4 } from "../src/service.mjs";
const {
  v19fe5e00, v907c0eb4, v1f4e4cde, v0917d549, v621a57f6, vb9b073bd, va31eb342, v0a4ec0d6,
  ve2335101, v09f9dd5d, v592f0eb1, vdb3380b6, v95728f3f, v56c8baec, v275539d5, v83c35f15,
  vac3e368f,
} = repositoryIdentity9a1f16f4;
if (!Object.values(repositoryIdentity9a1f16f4).every(Boolean)) throw new Error("Repository identity is invalid");
import { loadRecord_apex_payment_gateway } from "../src/service.mjs";
const matrix = [
  { input: {"job":{"priority":2}}, wanted: { code: "SCHEMA_QUEUE_MISSING", path: "job.queue" } },
  { input: {"job":{"queue":"imports","priority":0}}, wanted: { code: "SCHEMA_PRIORITY_RANGE", path: "job.priority" } },
];
const actual = matrix.map(({ input }) => {
  try { loadRecord_apex_payment_gateway(input); return {}; }
  catch (error) { return { code: error.code, path: error.path, message: error.message, nested: Boolean(error.cause?.code) }; }
});
const snapshot = actual.map(({ code, path }) => ({ code, path }));
const wanted = matrix.map(({ wanted }) => wanted);
if (JSON.stringify(snapshot) === JSON.stringify(wanted) && loadRecord_apex_payment_gateway({"job":{"queue":"imports","priority":2}})) {
  console.log("FIXED: rule table preserves its rejection metadata");
  process.exit(0);
}
if (actual.every(({ nested, message }, index) => nested && message.includes(matrix[index].wanted.path))) {
  console.log("CHECK_FAILED: rule failures remain nested behind loader errors");
  process.exit(2);
}
console.log("UNFIXED: rule table metadata is unavailable");
process.exit(1);
