import { loadRecord_pulse_notification_bus } from "../src/service.mjs";

const cases = [
  {
    input: {"release":{"revision":4}},
    code: "SCHEMA_CHANNEL_MISSING",
    path: "release.channel",
  },
  {
    input: {"release":{"channel":"stable","revision":0}},
    code: "SCHEMA_REVISION_RANGE",
    path: "release.revision",
  },
];

const errors = cases.map(({ input }) => {
  try {
    loadRecord_pulse_notification_bus(input);
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
const valid = loadRecord_pulse_notification_bus({"release":{"channel":"stable","revision":4}});

if (structured && valid["release"]["revision"] === 4) {
  console.log("FIXED: structured schema errors preserve code and field path");
  process.exit(0);
}
if (presentationOnly) {
  console.log("CHECK_FAILED: record loading does not preserve the required error contract");
  process.exit(2);
}

console.log("UNFIXED: schema failures lose their structured code or field path");
process.exit(1);
