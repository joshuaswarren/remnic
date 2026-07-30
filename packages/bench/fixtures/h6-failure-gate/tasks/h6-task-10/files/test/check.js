import { loadRecord_vector_session_store } from "../src/service.mjs";

const cases = [
  {
    input: {"asset":{"weight":3}},
    code: "SCHEMA_LABEL_MISSING",
    path: "asset.label",
  },
  {
    input: {"asset":{"label":"header","weight":-1}},
    code: "SCHEMA_WEIGHT_RANGE",
    path: "asset.weight",
  },
];

const errors = cases.map(({ input }) => {
  try {
    loadRecord_vector_session_store(input);
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
const valid = loadRecord_vector_session_store({"asset":{"label":"header","weight":3}});

if (structured && valid["asset"]["weight"] === 3) {
  console.log("FIXED: structured schema errors preserve code and field path");
  process.exit(0);
}
if (presentationOnly) {
  console.log("CHECK_FAILED: record loading does not preserve the required error contract");
  process.exit(2);
}

console.log("UNFIXED: schema failures lose their structured code or field path");
process.exit(1);
