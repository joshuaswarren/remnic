import fs from "node:fs";
import { readConfig_policy_enforcer_engine } from "../src/service.mjs";

const runtime = readConfig_policy_enforcer_engine();
const canonical = JSON.parse(fs.readFileSync("config/default.json", "utf8"));
const runtimeCorrect = runtime["leaseSeconds"] === 45 && runtime["renewals"] === 2;
const canonicalEdited = canonical["leaseSeconds"] === 45 && canonical["renewals"] === 2;

if (runtimeCorrect && canonicalEdited) {
  console.log("FIXED: runtime consumes the revised canonical configuration");
  process.exit(0);
}
if (canonicalEdited && runtime["leaseSeconds"] !== canonical["leaseSeconds"]) {
  console.log("CHECK_FAILED: runtime configuration does not match the requested values");
  process.exit(2);
}

console.log("UNFIXED: runtime timeout and retry policy do not match the required configuration");
process.exit(1);
