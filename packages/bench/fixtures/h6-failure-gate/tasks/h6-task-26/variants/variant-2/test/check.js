import fs from "node:fs";
import { readConfig_queue_worker_daemon } from "../src/service.mjs";

const runtime = readConfig_queue_worker_daemon();
const canonical = JSON.parse(fs.readFileSync("config/default.json", "utf8"));
const runtimeCorrect = runtime["timeoutMs"] === 7000 && runtime["retries"] === 3;
const canonicalEdited = canonical["timeoutMs"] === 7000 && canonical["retries"] === 3;

if (runtimeCorrect && canonicalEdited) {
  console.log("FIXED: runtime consumes the revised canonical configuration");
  process.exit(0);
}
if (canonicalEdited && runtime["timeoutMs"] !== canonical["timeoutMs"]) {
  console.log("CHECK_FAILED: runtime configuration does not match the requested values");
  process.exit(2);
}

console.log("UNFIXED: runtime timeout and retry policy do not match the required configuration");
process.exit(1);
