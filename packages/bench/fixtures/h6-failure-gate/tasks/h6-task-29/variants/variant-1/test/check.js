import fs from "node:fs";
import { readConfig_schema_registry_store } from "../src/service.mjs";

const runtime = readConfig_schema_registry_store();
const canonical = JSON.parse(fs.readFileSync("config/default.json", "utf8"));
const runtimeCorrect = runtime["pageLimit"] === 60 && runtime["prefetch"] === 2;
const canonicalEdited = canonical["pageLimit"] === 60 && canonical["prefetch"] === 2;

if (runtimeCorrect && canonicalEdited) {
  console.log("FIXED: runtime consumes the revised canonical configuration");
  process.exit(0);
}
if (canonicalEdited && runtime["pageLimit"] !== canonical["pageLimit"]) {
  console.log("CHECK_FAILED: runtime configuration does not match the requested values");
  process.exit(2);
}

console.log("UNFIXED: runtime timeout and retry policy do not match the required configuration");
process.exit(1);
