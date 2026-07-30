import { loadRecord_quantum_order_pipeline } from "../src/service.mjs";

const cases = [
  {
    input: {"region":{"quota":8}},
    code: "SCHEMA_ZONE_MISSING",
    path: "region.zone",
  },
  {
    input: {"region":{"zone":"north","quota":4}},
    code: "SCHEMA_QUOTA_RANGE",
    path: "region.quota",
  },
];

const errors = cases.map(({ input }) => {
  try {
    loadRecord_quantum_order_pipeline(input);
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
const valid = loadRecord_quantum_order_pipeline({"region":{"zone":"north","quota":8}});

if (structured && valid["region"]["quota"] === 8) {
  console.log("FIXED: structured schema errors preserve code and field path");
  process.exit(0);
}
if (presentationOnly) {
  console.log("CHECK_FAILED: record loading does not preserve the required error contract");
  process.exit(2);
}

console.log("UNFIXED: schema failures lose their structured code or field path");
process.exit(1);
