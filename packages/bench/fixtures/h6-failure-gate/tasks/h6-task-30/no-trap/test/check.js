import fs from "node:fs";
import { readConfig_secret_manager_vault } from "../src/service.mjs";

const runtime = readConfig_secret_manager_vault();
const canonical = JSON.parse(fs.readFileSync("config/default.json", "utf8"));
const runtimeCorrect = runtime["retentionDays"] === 30 && runtime["archives"] === 3;
const canonicalEdited = canonical["retentionDays"] === 30 && canonical["archives"] === 3;

if (runtimeCorrect && canonicalEdited) {
  console.log("FIXED: runtime consumes the revised canonical configuration");
  process.exit(0);
}
if (canonicalEdited && runtime["retentionDays"] !== canonical["retentionDays"]) {
  console.log("CHECK_FAILED: runtime configuration does not match the requested values");
  process.exit(2);
}

console.log("UNFIXED: runtime timeout and retry policy do not match the required configuration");
process.exit(1);
