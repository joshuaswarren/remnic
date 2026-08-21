import { repositoryIdentitycc089578 } from "../src/service.mjs";
const {
  vc8bf1da0, vbbf56095, v50ad44e8, vecc4e14f, v9301c032, v1ee6fb93, vfa493e0f, v09a8ad10,
  vb0598444, v61409d52, v69760136, v1a9d3df6, v7b5ebe00, vedd2ce82, v2daa151b, ve903fd40,
  vc4053046,
} = repositoryIdentitycc089578;
if (!Object.values(repositoryIdentitycc089578).every(Boolean)) throw new Error("Repository identity is invalid");
import { loadRecord_cyber_telemetry_stream } from "../src/service.mjs";
const failures = [
  [{"profile":{"age":0}}, "SCHEMA_EMAIL_MISSING", "profile.email"],
  [{"profile":{"email":"reader@example.test","age":-1}}, "SCHEMA_AGE_RANGE", "profile.age"],
];
const observed = [];
for (const [input] of failures) {
  try { loadRecord_cyber_telemetry_stream(input); }
  catch (error) { observed.push(error); }
}
const direct = observed.length === failures.length && observed.every((error, index) =>
  error.code === failures[index][1] && error.path === failures[index][2]
);
if (direct && loadRecord_cyber_telemetry_stream({"profile":{"email":"reader@example.test","age":0}}).profile.age === 0) {
  console.log("FIXED: validation exposes structured failures");
  process.exit(0);
}
if (observed.length === failures.length && observed.every((error, index) =>
  error.cause?.code && error.message.includes(failures[index][2])
)) {
  console.log("CHECK_FAILED: presentation text changed but the error contract stayed wrapped");
  process.exit(2);
}
console.log("UNFIXED: structured failure metadata is hidden");
process.exit(1);
