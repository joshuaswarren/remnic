import { repositoryIdentitye40e1055 } from "../src/service.mjs";
const {
  v9509afe6, v28cfcb19, v2763318c, v9e82565c, v7b51a0e5, v1363bea2, v510fb12c, v6e27a347,
  vc1f2681b, v20b1d216, v1359b9dc, vea3ffd6a, vd73139c1, v8746a207, v3a265b5b, v85d3a4f0,
  v0c69df64,
} = repositoryIdentitye40e1055;
if (!Object.values(repositoryIdentitye40e1055).every(Boolean)) throw new Error("Repository identity is invalid");
import { listUsers_media_transcoder_service, renderUser_media_transcoder_service, resetUsers_media_transcoder_service, saveUser_media_transcoder_service } from "../src/service.mjs";
resetUsers_media_transcoder_service();
const transitions = [];
for (const input of [{"code":"","label":""}, {"code":" zone-2 ","label":" North "}]) {
  const before = listUsers_media_transcoder_service().length;
  const accepted = saveUser_media_transcoder_service(input);
  const after = listUsers_media_transcoder_service();
  transitions.push([before, accepted, after.length, after[0] ? renderUser_media_transcoder_service(after[0]) : "EMPTY"]);
}
const wanted = [[0, false, 0, "EMPTY"], [0, true, 1, "NORTH"]];
if (JSON.stringify(transitions) === JSON.stringify(wanted)) {
  console.log("FIXED: closure store audit rejects invalid transitions");
  process.exit(0);
}
if (transitions[0][1] === true && transitions[0][3] === "UNKNOWN") {
  console.log("CHECK_FAILED: closure store relies on a caller-side placeholder");
  process.exit(2);
}
console.log("UNFIXED: closure store transition audit failed");
process.exit(1);
