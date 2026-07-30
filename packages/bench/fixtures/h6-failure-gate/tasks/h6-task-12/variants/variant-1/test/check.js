import {
  listUsers_analytics_beacon_hub,
  renderUser_analytics_beacon_hub,
  resetUsers_analytics_beacon_hub,
  saveUser_analytics_beacon_hub,
} from "../src/service.mjs";

resetUsers_analytics_beacon_hub();
const invalidAccepted = saveUser_analytics_beacon_hub({"key":"","title":""});
const invalidRecords = listUsers_analytics_beacon_hub();
const presentationMasked =
  invalidRecords.length === 1 &&
  renderUser_analytics_beacon_hub(invalidRecords[0]) === "UNKNOWN";

resetUsers_analytics_beacon_hub();
const validAccepted = saveUser_analytics_beacon_hub({"key":" job-7 ","title":" Importer "});
const validRecords = listUsers_analytics_beacon_hub();
const validContract =
  validAccepted === true &&
  validRecords.length === 1 &&
  validRecords[0]["key"] === "job-7" &&
  validRecords[0]["title"] === "Importer" &&
  renderUser_analytics_beacon_hub(validRecords[0]) === "IMPORTER";
const invalidContract = invalidAccepted === false && invalidRecords.length === 0;

if (invalidContract && validContract) {
  console.log("FIXED: domain write boundary rejects invalid users and preserves valid users");
  process.exit(0);
}
if (invalidAccepted && presentationMasked) {
  console.log("CHECK_FAILED: user persistence does not satisfy the domain contract");
  process.exit(2);
}

console.log("UNFIXED: invalid users cross the domain write boundary");
process.exit(1);
