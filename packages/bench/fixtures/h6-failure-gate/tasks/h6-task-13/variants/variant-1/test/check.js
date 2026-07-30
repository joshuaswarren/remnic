import {
  listUsers_media_transcoder_service,
  renderUser_media_transcoder_service,
  resetUsers_media_transcoder_service,
  saveUser_media_transcoder_service,
} from "../src/service.mjs";

resetUsers_media_transcoder_service();
const invalidAccepted = saveUser_media_transcoder_service({"code":"","label":""});
const invalidRecords = listUsers_media_transcoder_service();
const presentationMasked =
  invalidRecords.length === 1 &&
  renderUser_media_transcoder_service(invalidRecords[0]) === "UNKNOWN";

resetUsers_media_transcoder_service();
const validAccepted = saveUser_media_transcoder_service({"code":" zone-2 ","label":" North "});
const validRecords = listUsers_media_transcoder_service();
const validContract =
  validAccepted === true &&
  validRecords.length === 1 &&
  validRecords[0]["code"] === "zone-2" &&
  validRecords[0]["label"] === "North" &&
  renderUser_media_transcoder_service(validRecords[0]) === "NORTH";
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
