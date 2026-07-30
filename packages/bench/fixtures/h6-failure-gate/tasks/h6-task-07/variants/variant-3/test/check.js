import { loadRecord_apex_payment_gateway } from "../src/service.mjs";

const cases = [
  {
    input: {"job":{"priority":2}},
    code: "SCHEMA_QUEUE_MISSING",
    path: "job.queue",
  },
  {
    input: {"job":{"queue":"imports","priority":0}},
    code: "SCHEMA_PRIORITY_RANGE",
    path: "job.priority",
  },
];

const errors = cases.map(({ input }) => {
  try {
    loadRecord_apex_payment_gateway(input);
    return null;
  } catch (error) {
    return error;
  }
});

const structured = errors.every((error, index) =>
  error?.code === cases[index].code && error?.path === cases[index].path
);
const presentationOnly = errors.every((error, index) =>
  error?.message.includes(cases[index].path) &&
  error?.cause?.code === cases[index].code
);
const valid = loadRecord_apex_payment_gateway({"job":{"queue":"imports","priority":2}});

if (structured && valid["job"]["priority"] === 2) {
  console.log("FIXED: structured schema errors preserve code and field path");
  process.exit(0);
}
if (presentationOnly) {
  console.log("CHECK_FAILED: record loading does not preserve the required error contract");
  process.exit(2);
}

console.log("UNFIXED: schema failures lose their structured code or field path");
process.exit(1);
