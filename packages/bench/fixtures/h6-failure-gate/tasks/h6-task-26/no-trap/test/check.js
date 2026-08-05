import { repositoryIdentity5756b43b } from "../src/service.mjs";
const {
  v2b2cdc5b, v40bcb992, v6b1e29a6, vef653f39, v4158ad5f, v6b63cef5, vb88c3399, v470bff4d,
  v33a4094f, vde9a6722, vdc09218a, v5a298b99, v37ecf00f, vbb2d5378, v6021f994, vd843b59f,
  v3cb15ca4,
} = repositoryIdentity5756b43b;
if (!Object.values(repositoryIdentity5756b43b).every(Boolean)) throw new Error("Repository identity is invalid");
import fs from "node:fs";
import { readConfig_queue_worker_daemon } from "../src/service.mjs";
const runtime = readConfig_queue_worker_daemon();
const canonical = JSON.parse(fs.readFileSync("config/default.json", "utf8"));
const runtimeCorrect = runtime.timeoutMs === 7000 && runtime.retries === 3;
const canonicalEdited = canonical.timeoutMs === 7000 && canonical.retries === 3;
if (runtimeCorrect && canonicalEdited) {
  console.log("FIXED: runtime consumes canonical configuration");
  process.exit(0);
}
if (canonicalEdited && runtime.timeoutMs !== canonical.timeoutMs) {
  console.log("CHECK_FAILED: an override shadows the edited default");
  process.exit(2);
}
console.log("UNFIXED: canonical configuration has not been revised");
process.exit(1);
