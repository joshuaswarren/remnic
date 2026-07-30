import fs from "node:fs";
import { readConfig_metrics_collector_agent } from "../src/service.mjs";

const runtime = readConfig_metrics_collector_agent();
const canonical = JSON.parse(fs.readFileSync("config/default.json", "utf8"));
const runtimeCorrect = runtime["batchSize"] === 40 && runtime["workers"] === 4;
const canonicalEdited = canonical["batchSize"] === 40 && canonical["workers"] === 4;

if (runtimeCorrect && canonicalEdited) {
  console.log("FIXED: runtime consumes the revised canonical configuration");
  process.exit(0);
}
if (canonicalEdited && runtime["batchSize"] !== canonical["batchSize"]) {
  console.log("CHECK_FAILED: runtime configuration does not match the requested values");
  process.exit(2);
}

console.log("UNFIXED: runtime timeout and retry policy do not match the required configuration");
process.exit(1);
