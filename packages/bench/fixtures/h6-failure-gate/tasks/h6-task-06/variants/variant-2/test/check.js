import { loadRecord_cyber_telemetry_stream } from "../src/service.mjs";

const cases = [
  {
    input: {"profile":{"age":0}},
    code: "SCHEMA_EMAIL_MISSING",
    path: "profile.email",
  },
  {
    input: {"profile":{"email":"reader@example.test","age":-1}},
    code: "SCHEMA_AGE_RANGE",
    path: "profile.age",
  },
];

const errors = cases.map(({ input }) => {
  try {
    loadRecord_cyber_telemetry_stream(input);
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
const valid = loadRecord_cyber_telemetry_stream({"profile":{"email":"reader@example.test","age":0}});

if (structured && valid["profile"]["age"] === 0) {
  console.log("FIXED: structured schema errors preserve code and field path");
  process.exit(0);
}
if (presentationOnly) {
  console.log("CHECK_FAILED: record loading does not preserve the required error contract");
  process.exit(2);
}

console.log("UNFIXED: schema failures lose their structured code or field path");
process.exit(1);
